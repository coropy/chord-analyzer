/**
 * Synthetic note-set generator for the Phase 2 renderer benchmark.
 * Deterministic (seeded) so results are comparable across runs.
 * Produces a NoteSet (SoA) whose `order` is sorted by startTick.
 */
import type { NoteSet } from './NoteSet';

/** Deterministic PRNG (xorshift32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface GenParams {
  count: number;
  seed?: number;
  minPitch?: number;
  maxPitch?: number;
  ppq?: number;
  /** beats per quarter; total length scaled by count */
  durationBeats?: number;
  minDurTicks?: number;
  maxDurTicks?: number;
  /** fraction of notes that are long-held (test overlapping tails) */
  longFrac?: number;
}

/** Build a synthetic NoteSet. */
export function generateNotes(p: GenParams): NoteSet {
  const seed = p.seed ?? 12345;
  const rnd = mulberry32(seed);
  const minPitch = p.minPitch ?? 24;
  const maxPitch = p.maxPitch ?? 103;
  const ppq = p.ppq ?? 120;
  const durationBeats = p.durationBeats ?? 240;
  const minDur = p.minDurTicks ?? ppq / 4;
  const maxDurTicks = p.maxDurTicks ?? ppq * 4;
  const longFrac = p.longFrac ?? 0.1;

  const count = p.count;
  const startTicks = new Float32Array(count);
  const endTicks = new Float32Array(count);
  const pitches = new Float32Array(count);
  const velocities = new Float32Array(count);
  const tracks = new Float32Array(count);
  const order = new Int32Array(count);

  const totalTicks = durationBeats * ppq;

  let t = 0;
  for (let i = 0; i < count; i++) {
    startTicks[i] = t;
    const d = rnd() < longFrac ? maxDurTicks : minDur + rnd() * (maxDurTicks - minDur);
    endTicks[i] = t + d;
    pitches[i] = minPitch + Math.floor(rnd() * (maxPitch - minPitch + 1));
    velocities[i] = 0.6 + rnd() * 0.4;
    tracks[i] = Math.floor(rnd() * 11);
    order[i] = i;
    t += totalTicks / count;
    t += (rnd() - 0.5) * (totalTicks / count) * 0.5;
  }

  const tmp = new Array(count);
  for (let i = 0; i < count; i++) tmp[i] = i;
  tmp.sort((a, b) => startTicks[a] - startTicks[b]);
  for (let i = 0; i < count; i++) order[i] = tmp[i];

  let mn = Infinity, mx = -Infinity, maxDurObs = 0;
  for (let i = 0; i < count; i++) {
    if (startTicks[i] < mn) mn = startTicks[i];
    if (endTicks[i] > mx) mx = endTicks[i];
    const dd = endTicks[i] - startTicks[i];
    if (dd > maxDurObs) maxDurObs = dd;
  }

  return {
    startTicks, endTicks, pitches, velocities, tracks, order,
    count, minTick: mn, maxTick: mx, maxDur: maxDurObs,
  };
}