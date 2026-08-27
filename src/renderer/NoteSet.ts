/** Immutable note dataset (SoA). Produced once (Worker in final app; synthetic in benchmark). */
export interface NoteSet {
  /** parallel float arrays */
  startTicks: Float32Array;
  endTicks: Float32Array;
  pitches: Float32Array;   // 0..127
  velocities: Float32Array; // 0..1
  tracks: Float32Array;
  /** indices sorted by startTick (ascending) for range culling */
  order: Int32Array;
  count: number;
  minTick: number;
  maxTick: number;
  /** max note duration in ticks (to include overlapping notes born before viewport left). */
  maxDur: number;
}