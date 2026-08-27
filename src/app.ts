/**
 * Phase 3 app: Timeline (piano roll + grid + playhead) with WAV playback.
 *
 * - Tick-canonical: MIDI parsed to SoA notes; WebGL renderer draws via uniforms.
 * - Audio: WAV via AudioSource; position from audio engine clock only.
 * - Camera: zoom/scroll; screenX<->tick transforms ready for markers.
 * - Track visibility toggles; grid (bar/beat/division) + piano strip.
 * - Perf overlay: FPS, frame ms, CPU/GPU, visible notes.
 */
import './style.css';
import { parseMidi } from './midi/MidiParser';
import { buildNoteModel, type NoteModel } from './model/NoteModel';
import { WebGL2NoteRenderer, type RenderView } from './renderer/WebGL2NoteRenderer';
import { WavAudioSource, type AudioTimelineSource } from './audio/AudioSource';
import { buildTempoMap, tickToSeconds, secondsToTick, type TempoMap } from './time/timeline';
import { gridConfig } from './time/grid';
import { makeCamera, xToTick, yToPitch, type CameraView } from './time/camera';
import { drawGridAndPlayhead, drawPianoKeys } from './renderer/overlay2d';
import { FrameTimeHistogram } from './perf/frameStats';

const MIDI_PATH = '/data/nakanori_mt3.mid';
const WAV_PATH = '/data/nakanori_instrumental.wav';
const MIDI_MIN_PITCH = 34;
const MIDI_MAX_PITCH = 103;

export function mount(root: HTMLElement): void {
  root.innerHTML = `
    <div id="wrap">
      <div id="topbar">
        <span class="brand">Chord Analyzer — Timeline</span>
        <button id="playBtn" disabled>▶ Play</button>
        <button id="stopBtn" disabled>■ Stop</button>
        <span id="pos">0.000s / 0.000s</span>
        <span class="sep"></span>
        <label>Grid <select id="gridSel">
          <option value="4">1/4</option><option value="8" selected>1/8</option>
          <option value="16">1/16</option><option value="32">1/32</option>
        </select></label>
        <span class="sep"></span>
        <span id="fps">— FPS</span>
        <span id="fr">— ms</span>
        <span id="cpu">cpu —</span>
        <span id="gpu">gpu —</span>
        <span id="vis">vis —</span>
      </div>
      <div id="stage">
        <div id="pianoWrap"><canvas id="piano"></canvas></div>
        <div id="timelineWrap"><canvas id="gl"></canvas><canvas id="overlay"></canvas></div>
      </div>
      <div id="trackbar"></div>
    </div>`;

  const playBtn = root.querySelector('#playBtn') as HTMLButtonElement;
  const stopBtn = root.querySelector('#stopBtn') as HTMLButtonElement;
  const posEl = root.querySelector('#pos') as HTMLElement;
  const glCanvas = root.querySelector('#gl') as HTMLCanvasElement;
  const overlay = root.querySelector('#overlay') as HTMLCanvasElement;
  const piano = root.querySelector('#piano') as HTMLCanvasElement;
  const topbar = root.querySelector('#topbar') as HTMLElement;
  const trackbar = root.querySelector('#trackbar') as HTMLElement;
  const fpsEl = root.querySelector('#fps') as HTMLElement;
  const frEl = root.querySelector('#fr') as HTMLElement;
  const cpuEl = root.querySelector('#cpu') as HTMLElement;
  const gpuEl = root.querySelector('#gpu') as HTMLElement;
  const visEl = root.querySelector('#vis') as HTMLElement;

  const PIANO_W = 52;
  const applySize = (): void => {
    const bg = root.querySelector('#wrap') as HTMLElement;
    const w = Math.max(200, bg.clientWidth - PIANO_W);
    const h = Math.max(240, bg.clientHeight - topbar.offsetHeight - trackbar.offsetHeight);
    for (const c of [glCanvas, overlay]) {
      c.width = w; c.height = h;
      c.style.width = w + 'px'; c.style.height = h + 'px';
    }
    piano.width = PIANO_W; piano.height = h;
    piano.style.height = h + 'px';
  };
  applySize();
  window.addEventListener('resize', applySize);

  const gl = glCanvas.getContext('webgl2', { antialias: true, alpha: false });
  if (!gl) { playBtn.textContent = 'No WebGL2'; return; }
  gl.clearColor(0.08, 0.085, 0.11, 1);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  const renderer = new WebGL2NoteRenderer(gl);

  let model: NoteModel;
  let tempoMap: TempoMap | null = null;
  let audio: AudioTimelineSource | null = null;
  let camera = makeCamera({ scrollTick: 0, pxPerTick: 0.2, topPitch: MIDI_MAX_PITCH + 1, pxPerPitch: 6 });
  let trackVisible: boolean[] = [];
  let playheadTick = 0;
  let gridDiv = 8;

  const renderView = (): RenderView =>
    ({ scrollStartTick: camera.scrollTick, pxPerTick: camera.pxPerTick, topPitch: camera.topPitch, pxPerPitch: camera.pxPerPitch, viewportWidth: glCanvas.width, viewportHeight: glCanvas.height });

  // ---- track controls ----
  function renderTracks(n: number): void {
    trackbar.innerHTML = '';
    for (let i = 0; i < n; i++) {
      const label = document.createElement('label');
      label.className = 'trackRow';
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = true;
      const span = document.createElement('span');
      span.textContent = `T${i} · ${trackCounts[i] ?? 0} notes`;
      cb.addEventListener('change', () => {
        trackVisible[i] = cb.checked;
        renderer.setTrackVisibility([...trackVisible]);
      });
      label.append(cb, span);
      trackbar.appendChild(label);
    }
  }
  let trackCounts: number[] = [];

  // ---- load data ----
  async function load(): Promise<void> {
    (window as unknown as Record<string, unknown>).__appDebug = { step: 'fetch-init' };
    const [mb, wb] = await Promise.all([
      (await fetch(MIDI_PATH)).arrayBuffer(),
      (await fetch(WAV_PATH)).arrayBuffer(),
    ]);
    (window as unknown as Record<string, unknown>).__appDebug = { step: 'fetched-wav', size: wb.byteLength };
    const doc = parseMidi(new Uint8Array(mb));
    tempoMap = buildTempoMap(doc);
    model = buildNoteModel(doc.notes);
    trackVisible = Array.from({ length: doc.tracks.length }, () => true);
    trackCounts = doc.tracks.map((t) => t.noteCount);
    renderer.uploadNotes(model);
    renderer.setTrackVisibility(trackVisible);

    const fitP = glCanvas.height / ((MIDI_MAX_PITCH - MIDI_MIN_PITCH) + 2);
    camera = makeCamera({
      scrollTick: model.minTick,
      pxPerTick: glCanvas.width / Math.max(1, model.maxTick - model.minTick),
      topPitch: MIDI_MAX_PITCH + 1,
      pxPerPitch: fitP,
    });
    (window as unknown as Record<string, unknown>).__appDebug = { step: 'midi-done', notes: model.count };

    audio = new WavAudioSource(wb);
    (window as unknown as Record<string, unknown>).__appDebug = { step: 'wav-decoding' };
    await audio.load();
    (window as unknown as Record<string, unknown>).__appDebug = { step: 'audio-loaded' };
    playBtn.disabled = false;
    stopBtn.disabled = false;
    renderTracks(doc.tracks.length);
  }

  // ---- playback ----
  playBtn.addEventListener('click', () => {
    if (!audio?.loaded) return;
    audio.play();
    playBtn.textContent = 'Ⅱ Pause';
  });
  stopBtn.addEventListener('click', () => {
    audio?.stop();
    playheadTick = 0;
    playBtn.textContent = '▶ Play';
  });

  function seekToTick(tick: number): void {
    if (!audio?.loaded || !tempoMap) return;
    audio.seek(tickToSeconds(tempoMap, tick));
    playheadTick = tick;
  }

  // ---- interactions ----
  let pan = { x: 0, y: 0, down: false, moved: false };
  glCanvas.addEventListener('pointerdown', (e) => {
    pan.x = e.clientX; pan.y = e.clientY; pan.down = true; pan.moved = false;
    glCanvas.setPointerCapture(e.pointerId);
  });
  glCanvas.addEventListener('pointermove', (e) => {
    if (!pan.down) return;
    const dx = e.clientX - pan.x, dy = e.clientY - pan.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) pan.moved = true;
    if (pan.moved) {
      camera = { ...camera, scrollTick: camera.scrollTick - dx / camera.pxPerTick, topPitch: camera.topPitch + dy / camera.pxPerPitch };
      pan.x = e.clientX; pan.y = e.clientY;
    }
  });
  glCanvas.addEventListener('pointerup', (e) => {
    if (!pan.down) return;
    pan.down = false;
    if (!pan.moved) {
      const rect = glCanvas.getBoundingClientRect();
      const tick = Math.round(xToTick(camera, e.clientX - rect.left));
      seekToTick(tick);
    }
  });
  glCanvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = glCanvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    if (e.shiftKey) {
      const anchorPitch = yToPitch(camera, my);
      const np = Math.max(0.5, Math.min(60, camera.pxPerPitch * f));
      camera = { ...camera, pxPerPitch: np, topPitch: anchorPitch + my / np };
    } else {
      const anchorTick = xToTick(camera, mx);
      const npx = Math.max(1e-4, Math.min(5, camera.pxPerTick * f));
      camera = { ...camera, pxPerTick: npx, scrollTick: anchorTick - mx / npx };
    }
  });

  (root.querySelector('#gridSel') as HTMLSelectElement).addEventListener('change', (e) => {
    gridDiv = Number((e.target as HTMLSelectElement).value);
  });

  // ---- render loop ----
  const hist = new FrameTimeHistogram(360);
  let lastNow = performance.now();
  const oCtx = overlay.getContext('2d')!;
  const pCtx = piano.getContext('2d');

  const frame = (now: number): void => {
    const ms = now - lastNow; lastNow = now;
    hist.push(ms);
    const st = hist.computeStats();

    if (!model || !tempoMap) { requestAnimationFrame(frame); return; }

    if (audio?.loaded) {
      const pos = audio.getPositionSeconds();
      playheadTick = secondsToTick(tempoMap, pos);
    }
    const view = renderView();
    renderer.draw(model, view);

    const oview: CameraView = { ...camera, viewportWidth: glCanvas.width, viewportHeight: glCanvas.height };
    const range = { left: oview.scrollTick, right: oview.scrollTick + oview.viewportWidth / oview.pxPerTick };
    const grid = gridConfig(4, 2, tempoMap?.ppq ?? 480, gridDiv);
    drawGridAndPlayhead(oCtx, oview, grid, range, playheadTick);
    if (pCtx) drawPianoKeys(piano, oview);

    const sec = tempoMap ? tickToSeconds(tempoMap, playheadTick) : 0;
    posEl.textContent = sec.toFixed(3) + 's / ' + (tempoMap?.durationSeconds ?? 0).toFixed(3) + 's';
    fpsEl.textContent = st.avgFps.toFixed(0) + ' FPS';
    frEl.textContent = st.avgMs.toFixed(2) + ' ms';
    cpuEl.textContent = 'cpu ' + renderer.cpuUpdateMs.toFixed(3);
    gpuEl.textContent = 'gpu ' + renderer.drawMs.toFixed(3);
    visEl.textContent = 'vis ' + renderer.lastVisible;

    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  void load().catch((e) => {
    console.error('load failed:', e);
    playBtn.textContent = 'Load error';
    playBtn.disabled = false;
  });
}

export function mountApp(root: HTMLElement): void {
  mount(root);
}