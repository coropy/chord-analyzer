/**
 * Minimal WebGL2 note renderer for the Phase 2 benchmark.
 *
 * Approved architecture:
 *  - Notes: fixed SoA TypedArrays uploaded once (static interleaved VBO).
 *  - CPU never recomputes screen coords for ALL notes. Each frame it culls the
 *    *visible* subset (binary search over a start-tick-sorted index) into one
 *    reused instance buffer, then issues a single instanced draw.
 *  - Vertex shader maps (tick,pitch) -> NDC via camera uniforms. Zoom, scroll,
 *    pitch range are uniforms — changing them uploads no note data.
 *  - CPU->GPU transfer minimized: only the visible slice is re-uploaded via
 *    gl.bufferSubData into one reused buffer, and only when the visible count
 *    changed. Pure playback changes no uniform beyond camera (none needed for notes).
 *  - Render loop allocates nothing: instance scratch is reused, buffers preallocated.
 */

import type { NoteSet } from './NoteSet';

const VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 aQuad;   // unit quad 0..1
layout(location=1) in vec4 aRect;   // (startTick, endTick, pitch, velocity01)
uniform float uPxPerTick;
uniform float uScrollTick;   // tick at left edge of viewport
uniform float uPxPerPitch;
uniform float uBottomPitch;  // pitch (MIDI number) at bottom edge
uniform vec2  uViewport;     // canvas size in px
out vec3 vColor;
void main() {
  float x  = mix(aRect.x, aRect.y, aQuad.x);
  float px = (x - uScrollTick) * uPxPerTick;
  float py = (aRect.z - uBottomPitch) * uPxPerPitch;
  vec2 n = vec2(px, py) / uViewport * 2.0 - vec2(1.0, 1.0);
  gl_Position = vec4(n.x, -n.y, 0.0, 1.0); // y down in canvas -> flip so pitch up
  vColor = vec3(0.30, 0.75, 1.00) * (0.45 + 0.55 * aRect.w);
}
`;

const FS = `#version 300 es
precision highp float;
in vec3 vColor;
out vec4 fragColor;
void main(){ fragColor = vec4(vColor, 1.0); }
`;

const UNIT_QUAD = new Float32Array([0,0, 1,0, 0,1, 0,1, 1,0, 1,1]);

export interface RenderView {
  scrollStartTick: number;
  pxPerTick: number;
  bottomPitch: number;
  pxPerPitch: number;
  viewportWidth: number;
  viewportHeight: number;
}

export interface GLNoteRenderer {
  uploadNotes(n: NoteSet): void;
  draw(n: NoteSet, view: RenderView): void;
  gl: WebGL2RenderingContext;
  cpuUpdateMs: number;
  drawMs: number;
  lastVisible: number;
  lastUploadBytes: number;
}

/** First index into notes.order where startTick >= t. */
function lowerBoundStart(notes: NoteSet, t: number): number {
  const o = notes.order, s = notes.startTicks, n = notes.count;
  let lo = 0, hi = n;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (s[o[m]] < t) lo = m + 1; else hi = m;
  }
  return lo;
}

export class WebGL2NoteRenderer implements GLNoteRenderer {
  gl: WebGL2RenderingContext;
  cpuUpdateMs = 0;
  drawMs = 0;
  lastVisible = 0;
  lastUploadBytes = 0;

  private program: WebGLProgram;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private vao: WebGLVertexArrayObject;
  private quadVbo: WebGLBuffer;
  private instVbo: WebGLBuffer;
  private scratch: Float32Array = new Float32Array(0);
  private scratchCap = 0;
  private lastVisibleUploaded = -1;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.program = this.link();
    for (const n of ['uPxPerTick','uScrollTick','uPxPerPitch','uBottomPitch','uViewport']) {
      this.uniforms[n] = gl.getUniformLocation(this.program, n);
    }
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    this.quadVbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVbo);
    gl.bufferData(gl.ARRAY_BUFFER, UNIT_QUAD, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
    this.instVbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instVbo);
    gl.bufferData(gl.ARRAY_BUFFER, 4096 * 16, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 16, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.bindVertexArray(null);
  }

  private compile(type: number, src: string): WebGLShader {
    const g = this.gl;
    const sh = g.createShader(type)!;
    g.shaderSource(sh, src); g.compileShader(sh);
    if (!g.getShaderParameter(sh, g.COMPILE_STATUS)) throw new Error('shader: ' + g.getShaderInfoLog(sh));
    return sh;
  }
  private link(): WebGLProgram {
    const g = this.gl;
    const vs = this.compile(g.VERTEX_SHADER, VS);
    const fs = this.compile(g.FRAGMENT_SHADER, FS);
    const p = g.createProgram()!;
    g.attachShader(p, vs); g.attachShader(p, fs); g.linkProgram(p);
    if (!g.getProgramParameter(p, g.LINK_STATUS)) throw new Error('link: ' + g.getProgramInfoLog(p));
    g.deleteShader(vs); g.deleteShader(fs);
    return p;
  }

  uploadNotes(_n: NoteSet): void {
    this.lastVisibleUploaded = -1; // force re-upload next draw
  }

  /** Fill scratch with visible notes; return visible count. */
  private cull(notes: NoteSet, tLo: number, tHi: number): number {
    const o = notes.order, s = notes.startTicks, e = notes.endTicks;
    const fi = lowerBoundStart(notes, tLo - notes.maxDur);
    const hi = lowerBoundStart(notes, tHi + 1e-9);
    let w = 0;
    const st = this.scratch;
    for (let i = fi; i < hi; i++) {
      const idx = o[i];
      if (e[idx] < tLo) continue;
      const base = w * 4;
      st[base+0] = s[idx];
      st[base+1] = e[idx];
      st[base+2] = notes.pitches[idx];
      st[base+3] = notes.velocities[idx];
      w++;
    }
    this.lastVisible = w;
    return w;
  }

  draw(n: NoteSet, view: RenderView): void {
    const g = this.gl;
    const tLo = view.scrollStartTick;
    const tHi = tLo + view.viewportWidth / view.pxPerTick;

    // Estimate candidate range size to size scratch (fi..hi). Allocate a generous buffer.
    const maxDur = n.maxDur;
    const tSample = tLo - maxDur;
    // Number of notes with start in [tSample, tHi]: use binary search bounds.
    const fi = lowerBoundStart(n, tSample);
    const hi = lowerBoundStart(n, tHi + 1e-9);
    const candidate = hi - fi;
    const need = candidate * 4;
    if (need > this.scratchCap) {
      this.scratchCap = Math.max(this.scratchCap * 2, need, 4096);
      this.scratch = new Float32Array(this.scratchCap);
    }

    const t0 = performance.now();
    const visible = this.cull(n, tLo, tHi);
    this.cpuUpdateMs = performance.now() - t0;

    if (visible !== this.lastVisibleUploaded || visible === 0) {
      if (visible > 0) {
        g.bindBuffer(g.ARRAY_BUFFER, this.instVbo);
        g.bufferSubData(g.ARRAY_BUFFER, 0, this.scratch.subarray(0, visible * 4), 0);
        this.lastUploadBytes = visible * 16;
      }
      this.lastVisibleUploaded = visible;
    }

    const ds = performance.now();
    g.useProgram(this.program);
    g.uniform1f(this.uniforms.uPxPerTick, view.pxPerTick);
    g.uniform1f(this.uniforms.uScrollTick, view.scrollStartTick);
    g.uniform1f(this.uniforms.uPxPerPitch, view.pxPerPitch);
    g.uniform1f(this.uniforms.uBottomPitch, view.bottomPitch);
    g.uniform2f(this.uniforms.uViewport, view.viewportWidth, view.viewportHeight);
    g.bindVertexArray(this.vao);
    g.viewport(0, 0, view.viewportWidth, view.viewportHeight);
    if (visible > 0) g.drawArraysInstanced(g.TRIANGLES, 0, 6, visible);
    g.bindVertexArray(null);
    this.drawMs = performance.now() - ds;
  }
}