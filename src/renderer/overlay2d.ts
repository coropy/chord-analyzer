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
import type { Marker, ChordRegion } from '../marker/marker';
import { effectiveTick } from '../marker/marker';

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
  marker: string;
  markerSelected: string;
  region: string;
}

export const defaultTheme: OverlayTheme = {
  barLine: 'rgba(255,255,255,0.32)',
  beatLine: 'rgba(255,255,255,0.16)',
  divLine: 'rgba(255,255,255,0.08)',
  barText: 'rgba(230,230,230,0.90)',
  playhead: 'rgba(255,255,255,0.95)',
  octaveLine: 'rgba(255,255,255,0.10)',
  keyBg: '#0d0d0e',
  whiteKey: '#eceff4',
  blackKey: '#141416',
  marker: 'rgba(200,200,200,0.95)',
  markerSelected: 'rgba(255,255,255,1)',
  region: 'rgba(255,255,255,0.10)',
};

export interface VisibleRange { left: number; right: number; }

/** Snap a screen coordinate to the half-pixel grid (2 sub-pixels) so 1px lines
 *  stay crisp while still gliding smoothly during scroll.
 *
 *  NEVER snap to the full pixel grid: a threshold snap makes lines stick to an
 *  integer pixel while the camera keeps moving, then jump — visible as judder
 *  against the GPU-rendered notes which move continuously.
 *  Rounding to nearest half-pixel keeps <0.5px per-frame drift invisible while
 *  the line centre lands on a pixel, keeping 1px strokes sharp.
 *
 *  During playback/scroll the camera moves continuously, so a sub-pixel snap
 *  would make grid lines step in 0.5px increments while the GPU notes glide
 *  continuously: the two layers drift apart and re-overlap each frame, reading
 *  as a double-image flicker. Pass `moving=true` while the view scrolls so the
 *  overlay matches the notes exactly (no rounding). */
export function snapCoord(x: number, moving = false): number {
  if (moving) return x;
  return Math.round(x * 2) / 2;
}

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
  showBarText = true,
  moving = false,
): void {
  ctx.clearRect(0, 0, view.viewportWidth, view.viewportHeight);

  const lines = enumerateGridLines(grid, Math.floor(range.left), Math.ceil(range.right));
  ctx.lineWidth = 1;
  for (const l of lines) {
    // Adaptive snap: full-pixel crisp when nearly still, half-pixel glide
    // during scroll so grid/notes stay in lockstep without 1-2px jumps.
    const x = snapCoord(tickToX(view, l.tick), moving);
    if (x < -1 || x > view.viewportWidth + 1) continue;
    ctx.strokeStyle =
      l.kind === 'bar' ? theme.barLine :
      l.kind === 'beat' ? theme.beatLine : theme.divLine;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, view.viewportHeight);
    ctx.stroke();
    if (l.kind === 'bar' && showBarText) {
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
    const y = snapCoord(pitchToY(view, p), moving);
    ctx.strokeStyle = theme.octaveLine;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(view.viewportWidth, y);
    ctx.stroke();
  }

  // playhead
  const px = snapCoord(tickToX(view, playheadTick), moving);
  ctx.strokeStyle = theme.playhead;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(px, 0);
  ctx.lineTo(px, view.viewportHeight);
  ctx.stroke();
}

/**
 * Draw chord regions as translucent bands, then markers as crisp vertical lines.
 * Allocation-light: builds nothing per-frame beyond iterating the passed arrays.
 * Selected marker is highlighted.
 */
export function drawMarkersAndRegions(
  ctx: CanvasRenderingContext2D,
  view: CameraView,
  markers: Marker[],
  regions: ChordRegion[],
  selectedId: number | null,
  theme: OverlayTheme = defaultTheme,
  moving = false,
): void {
  // regions first (under markers)
  ctx.fillStyle = theme.region;
  for (const r of regions) {
    const x0 = tickToX(view, r.startTick);
    const x1 = tickToX(view, r.endTick);
    if (x1 < 0 || x0 > view.viewportWidth) continue;
    ctx.fillRect(x0, 0, Math.max(1, x1 - x0), view.viewportHeight);
  }
  // markers (vertical lines). Use effective tick for display.
  ctx.lineWidth = 2;
  for (const m of markers) {
    const t = effectiveTick(m);
    // adaptive snap for crisp lines when still, sub-pixel glide during playback
    const x = snapCoord(tickToX(view, t), moving);
    if (x < -2 || x > view.viewportWidth + 2) continue;
    ctx.strokeStyle = m.id === selectedId ? theme.markerSelected : theme.marker;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, view.viewportHeight);
    ctx.stroke();
  }
}

/** Draw the piano key strip (vertical) into `pianoEl`'s canvas at given height. */
export function drawPianoKeys(
  canvas: HTMLCanvasElement,
  view: CameraView,
  theme: OverlayTheme = defaultTheme,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const d = view.dpr && view.dpr > 0 ? view.dpr : 1;
  const W = canvas.width / d;  // logical CSS width
  const H = canvas.height / d; // logical CSS height
  ctx.setTransform(d, 0, 0, d, 0, 0);
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
    const y = Math.round(pitchToY(view, p)) + 0.5;
    const isBlack = p < 0 ? false : BLACKS.includes(p % 12);
    ctx.fillStyle = isBlack ? theme.blackKey : theme.whiteKey;
    ctx.fillRect(0, y - Math.round(view.pxPerPitch / 2), W, Math.ceil(view.pxPerPitch) + 1);
  }
}