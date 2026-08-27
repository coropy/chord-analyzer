/**
 * Marker + Chord Region model (pure data + pure helpers).
 *
 * A Marker records the exact (raw) audio position when Enter was pressed, plus
 * a quantizedTick on the current grid. rawTick is NEVER mutated; toggling
 * quantization or moving recomputes a fresh quantizedTick from rawTick.
 *
 * Chord Region = the span between adjacent markers (data ready to feed a future
 * Chord Analyzer — recognition is NOT implemented here).
 *
 * This module has no DOM/WebGL; the app drives it through the store in
 * history.ts. Rendering consumes `buildRegions`, which is allocation-light.
 */
import type { QuantizeDivision } from './quantize';
import { quantizeTick } from './quantize';

export interface Marker {
  id: number;
  /** exact tick captured from the audio engine position at Enter */
  rawTick: number;
  /** grid-aligned tick (derived from rawTick; never stored by mutation) */
  quantizedTick: number;
  /** whether quantization was ON when this marker was created */
  quantizeEnabled: boolean;
  /** division at creation (per-marker reference) */
  quantizeDivision: QuantizeDivision;
}

export interface ChordRegion {
  id: number;
  startTick: number;
  endTick: number;
  startMarkerId: number;
  endMarkerId: number;
}

export interface StoreState {
  markers: Marker[];
  selectedId: number | null;
  nextId: number;
}

export type QuantizeLayout = { enabled: boolean; division: QuantizeDivision };

export const ctx480 = { ppq: 480, numerator: 4 };

export function createState(): StoreState {
  return { markers: [], selectedId: null, nextId: 1 };
}

/** Create a marker; rawTick preserved, quantizedTick derived. */
export function makeMarker(
  id: number,
  rawTick: number,
  layout: QuantizeLayout,
  ctx: { ppq: number; numerator: number } = ctx480,
): Marker {
  const q = quantizeTick(rawTick, layout.division, ctx).quantizedTick;
  return {
    id,
    rawTick,
    quantizedTick: layout.enabled ? q : rawTick,
    quantizeEnabled: layout.enabled,
    quantizeDivision: layout.division,
  };
}

/** Recompute quantizedTick from the marker's (unchanged) rawTick. */
export function requantize(
  m: Marker,
  layout: QuantizeLayout,
  ctx: { ppq: number; numerator: number } = ctx480,
): Marker {
  const q = quantizeTick(m.rawTick, layout.division, ctx).quantizedTick;
  return {
    ...m,
    quantizedTick: layout.enabled ? q : m.rawTick,
    quantizeEnabled: layout.enabled,
    quantizeDivision: layout.division,
  };
}

/** Build Chord Regions from adjacent markers (sorted by effective tick). */
export function buildRegions(markers: Marker[]): ChordRegion[] {
  if (markers.length < 2) return [];
  const sorted = [...markers].sort((a, b) => effectiveTick(a) - effectiveTick(b));
  const out: ChordRegion[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i], b = sorted[i + 1];
    out.push({
      id: i,
      startTick: effectiveTick(a),
      endTick: effectiveTick(b),
      startMarkerId: a.id,
      endMarkerId: b.id,
    });
  }
  return out;
}

/** Effective display tick: quantized when enabled, else raw. */
export function effectiveTick(m: Marker): number {
  return m.quantizeEnabled ? m.quantizedTick : m.rawTick;
}