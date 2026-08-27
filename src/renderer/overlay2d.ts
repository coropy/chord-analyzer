/**
 * CPU-side overlay drawing: grid lines, playhead, ruler bar labels, piano key
 * strip. Drawn on a 2D `<canvas>` layered above the WebGL note canvas.
 *
 * These are crisp lines/labels; the heavy per-note work stays on the GPU.
 * Grid ticks are precomputed by `enumerateGridLines` (no per-frame tick math).
 */
import type { CameraView } from '../time/camera';
import { tickToX, pitchToY } from '../time/camera';
import type { GridConfig } from '../time/grid';
import { enumerateGridLines } from '../time/grid';

export interface OverlayTheme {
  barLine: string;
  beatLine: string;
  divLine: string;
  barText: string;
  playhead: string;
  octaveLine: string;
  keyBg: string;
  blackKey: string;
  whiteKey: string;
}

export const defaultTheme: OverlayTheme = {
  barLine: 'rgba(120,210,255,0.60)',
  beatLine: 'rgba(120,210,255,0.28)',
  divLine: 'rgba(120,210,255,0.12)',
  barText: 'rgba(210,235,255,0.95)',
  playhead: 'rgba(255,90,95,0.95)',
  octaveLine: 'rgba(255,255,255,0.10)',
  keyBg: '#0c1620',
  whiteKey: '#e9eef5',
  blackKey: '#11161d',
};

export interface VisibleRange { left: number; right: number; }

/**
 * Draw grid lines + playhead + bar labels onto ctx (already cleared by caller or
 * cleared here). `view` matches the WebGL camera so lines line up exactly.
 */
export function drawGridAndPlayhead(
  ctx: CanvasRenderingContext2D,
  view: CameraView,
  grid: GridConfig,
  range: VisibleRange,
  playheadTick: number,
  theme: OverlayTheme = defaultTheme,
): void {
  ctx.clearRect(0, 0, view.viewportWidth, view.viewportHeight);

  const lines = enumerateGridLines(grid, Math.floor(range.left), Math.ceil(range.right));
  ctx.lineWidth = 1;
  for (const l of lines) {
    const x = Math.round(tickToX(view, l.tick)) + 0.5;
    if (x < -1 || x > view.viewportWidth + 1) continue;
    ctx.strokeStyle =
      l.kind === 'bar' ? theme.barLine :
      l.kind === 'beat' ? theme.beatLine : theme.divLine;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, view.viewportHeight);
    ctx.stroke();
    if (l.kind === 'bar') {
      ctx.fillStyle = theme.barText;
      ctx.font = '10px system-ui';
      ctx.fillText(String(l.bar), x + 3, 12);
    }
  }

  // octave boundary lines (C pitches 12 apart)
  const topP = view.topPitch;
  const botP = view.topPitch - view.viewportHeight / view.pxPerPitch;
  const p0 = Math.floor(Math.min(topP, botP) / 12) * 12;
  const p1 = Math.ceil(Math.max(topP, botP) / 12) * 12;
  for (let p = p0; p <= p1; p += 12) {
    if (p < 0 || p > 127) continue;
    const y = pitchToY(view, p);
    ctx.strokeStyle = theme.octaveLine;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(y) + 0.5);
    ctx.lineTo(view.viewportWidth, Math.round(y) + 0.5);
    ctx.stroke();
  }

  // playhead
  const px = tickToX(view, playheadTick);
  ctx.strokeStyle = theme.playhead;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(px, 0);
  ctx.lineTo(px, view.viewportHeight);
  ctx.stroke();
}

/** Draw the piano key strip (vertical) into `pianoEl`'s canvas at given height. */
export function drawPianoKeys(
  canvas: HTMLCanvasElement,
  view: CameraView,
  theme: OverlayTheme = defaultTheme,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = theme.keyBg;
  ctx.fillRect(0, 0, W, H);
  // white keys = natural pitches; black keys = sharps
  const top = view.topPitch;
  const bot = top - H / view.pxPerPitch;
  const pLo = Math.floor(Math.min(top, bot));
  const pHi = Math.ceil(Math.max(top, bot));
  const BLACKS = [1, 3, 6, 8, 10]; // sharps within octave
  for (let p = pHi; p >= pLo; p--) {
    const y = pitchToY(view, p);
    const isBlack = p < 0 ? false : BLACKS.includes(p % 12);
    ctx.fillStyle = isBlack ? theme.blackKey : theme.whiteKey;
    ctx.fillRect(0, Math.round(y) - Math.round(view.pxPerPitch / 2), W, Math.ceil(view.pxPerPitch) + 1);
  }
}