/**
 * SoA (Structure-of-Arrays) note model built from a parsed MidiDocument.
 * Matches the WebGL renderer's TypedArray design: flat arrays, no per-note objects.
 *
 * `order` is an index permutation sorted by startTick for cheap range culling.
 */
import type { MidiDocument, MidiNoteEvent } from '../midi/MidiParser';
import type { NoteSet } from '../renderer/NoteSet';

export interface NoteModel {
  startTicks: Float32Array;
  endTicks: Float32Array;
  pitches: Float32Array;
  velocities: Float32Array;
  tracks: Float32Array;  // track index (0..n-1)
  channels: Float32Array; // 0..15
  /** index into `order`-sorted arrays; order sorted by startTick ascending */
  order: Int32Array;
  count: number;
  minTick: number;
  maxTick: number;
  maxDur: number;
  trackStartOrder: Int32Array; // first index in `order` for each present track
  trackCount: number;
}

export interface TrackVisibility {
  visible: boolean[];
  soloActive: boolean;
  solo: boolean[];
}

export function trackVisibleMask(tracksLen: number): TrackVisibility {
  return {
    visible: tracksLen > 0 ? Array.from({ length: tracksLen }, () => true) : [],
    soloActive: false,
    solo: tracksLen > 0 ? Array.from({ length: tracksLen }, () => false) : [],
  };
}

/**
 * Build a NoteSet (SoA) from parsed notes.
 * Assumes `doc.notes` sorted by startTick (parser does this).
 */
export function buildNoteModel(doc: MidiDocument | MidiNoteEvent[]): NoteModel {
  const notes: MidiNoteEvent[] = Array.isArray(doc) ? doc : doc.notes;
  const count = notes.length;
  const startTicks = new Float32Array(count);
  const endTicks = new Float32Array(count);
  const pitches = new Float32Array(count);
  const velocities = new Float32Array(count);
  const tracks = new Float32Array(count);
  const channels = new Float32Array(count);
  const order = new Int32Array(count);

  let minTick = Infinity, maxTick = -Infinity, maxDur = 0;
  // tracks present
  const trackSet = new Set<number>();
  for (let i = 0; i < count; i++) {
    const n = notes[i];
    startTicks[i] = n.startTick;
    endTicks[i] = n.endTick;
    pitches[i] = n.pitch;
    velocities[i] = n.velocity / 127;
    tracks[i] = n.track;
    channels[i] = n.channel;
    order[i] = i;
    trackSet.add(n.track);
    if (n.startTick < minTick) minTick = n.startTick;
    if (n.endTick > maxTick) maxTick = n.endTick;
    const d = n.endTick - n.startTick;
    if (d > maxDur) maxDur = d;
  }
  if (count === 0) { minTick = 0; maxTick = 0; }

  // order is already sorted if notes sorted; keep as-is (parser sorts). Defensive: sort.
  if (notes.length > 1) {
    const arr = Array.from(order);
    arr.sort((a, b) => startTicks[a] - startTicks[b] || tracks[a] - tracks[b] || pitches[a] - pitches[b]);
    order.set(arr);
  }

  // track ranges in order-space
  const trackOrder = Array.from(trackSet).sort((a, b) => a - b);
  const trackStartOrder = new Int32Array(trackOrder.length);
  let lastTrack = -1;
  for (let i = 0; i < count; i++) {
    const t = tracks[order[i]];
    if (t !== lastTrack) { lastTrack = t; trackStartOrder[trackOrder.indexOf(t)] = i; }
  }
  const trackCount = trackOrder.length;

  return {
    startTicks, endTicks, pitches, velocities, tracks, channels, order,
    count, minTick, maxTick: maxTick < 0 ? 0 : maxTick, maxDur: maxDur === Infinity ? 0 : maxDur,
    trackStartOrder, trackCount,
  };
}

/** Build a NoteSet directly (renderer contract) from model SoA. */
export function toRendererNoteSet(m: NoteModel): NoteSet {
  return {
    startTicks: m.startTicks,
    endTicks: m.endTicks,
    pitches: m.pitches,
    velocities: m.velocities,
    tracks: m.tracks,
    order: m.order,
    count: m.count,
    minTick: m.minTick,
    maxTick: m.maxTick,
    maxDur: m.maxDur,
  };
}