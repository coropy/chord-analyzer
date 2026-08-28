/**
 * Tick-canonical timeline math.
 *
 * tick is the canonical unit. Seconds and bar/beat are derived.
 * Tempo map (tick -> µs per quarter) becomes piecewise-linear segments with
 * precomputed cumulative *offsetTick* at each boundary. To convert tick->seconds
 * we find the last boundary <= tick, then add within-segment time in O(log n).
 * seconds->tick is the inverse, iterating segments.
 */
import type { MidiDocument } from '../midi/MidiParser';

export interface TempoMap {
  /** segment boundaries: tempo[tickAt]. tempo uses the segment starting at tickAt */
  boundaryTicks: number[]; // sorted, includes 0
  tempos: number[];         // µs/qn, parallel to boundaryTicks
  /** cumulative seconds from 0 up to each boundary */
  cumSeconds: number[];
  ppq: number;
  durationTicks: number;
  durationSeconds: number;
  /** single constant tempo if uniform (fast path) */
  constantTempo: number | null;
  defaultTempo: number;
}

/** Build tempo map from a parsed document. Defaults to 500000 µs (120bpm) if absent. */
export function buildTempoMap(doc: MidiDocument): TempoMap {
  const ppq = doc.ppq > 0 ? doc.ppq : 480;
  const events = [...doc.tempos].sort((a, b) => a.tick - b.tick);
  // ensure boundary at tick 0
  const boundaryTicks: number[] = [];
  const tempos: number[] = [];
  if (events.length && events[0].tick === 0) {
    boundaryTicks.push(0); tempos.push(events[0].tempo);
    for (let i = 1; i < events.length; i++) {
      if (events[i].tick > events[i - 1].tick) {
        boundaryTicks.push(events[i].tick); tempos.push(events[i].tempo);
      }
    }
  } else {
    boundaryTicks.push(0); tempos.push(events.length ? events[0].tempo : 500000);
    for (const e of events) {
      if (e.tick > 0) { boundaryTicks.push(e.tick); tempos.push(e.tempo); }
    }
  }

  const cumSeconds = new Array(boundaryTicks.length).fill(0);
  for (let i = 1; i < boundaryTicks.length; i++) {
    const dt = boundaryTicks[i] - boundaryTicks[i - 1];
    cumSeconds[i] = cumSeconds[i - 1] + dt / ppq * (tempos[i - 1] / 1_000_000);
  }

  let durationSeconds = 0;
  if (boundaryTicks.length === 1) {
    durationSeconds = doc.durationTicks / ppq * (tempos[0] / 1_000_000);
  } else {
    const last = boundaryTicks.length - 1;
    durationSeconds = cumSeconds[last] + (doc.durationTicks - boundaryTicks[last]) / ppq * (tempos[last] / 1_000_000);
  }

  const allSame = tempos.every((t) => t === tempos[0]);

  return {
    boundaryTicks, tempos, cumSeconds, ppq,
    durationTicks: doc.durationTicks,
    durationSeconds,
    constantTempo: allSame ? tempos[0] : null,
    defaultTempo: tempos[0],
  };
}

/** Last boundary index with boundaryTicks[i] <= tick. */
function segmentAt(map: TempoMap, tick: number): number {
  const b = map.boundaryTicks;
  let lo = 0, hi = b.length - 1;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (b[m] <= tick) lo = m; else hi = m - 1;
  }
  return lo;
}

/** tick → seconds. O(log segments). */
export function tickToSeconds(map: TempoMap, tick: number): number {
  if (map.constantTempo !== null) {
    return tick / map.ppq * (map.constantTempo / 1_000_000);
  }
  const t = Math.max(0, Math.min(map.durationTicks, tick));
  const i = segmentAt(map, t);
  return map.cumSeconds[i] + (t - map.boundaryTicks[i]) / map.ppq * (map.tempos[i] / 1_000_000);
}

/** seconds → tick. Inverse of tickToSeconds. Returns fractional (playhead keeps sub-pixel smoothness). */
export function secondsToTick(map: TempoMap, seconds: number): number {
  const s = Math.max(0, Math.min(map.durationSeconds, seconds));
  if (map.constantTempo !== null) {
    return s * map.ppq * 1_000_000 / map.constantTempo;
  }
  for (let i = map.boundaryTicks.length - 1; i >= 0; i--) {
    const startSec = map.cumSeconds[i];
    if (s >= startSec) {
      const localSec = s - startSec;
      const tick = map.boundaryTicks[i] + localSec * map.ppq * 1_000_000 / map.tempos[i];
      return Math.max(0, tick);
    }
  }
  return 0;
}

export interface BarBeat {
  bar: number;   // 1-based
  beat: number;  // 1-based
  beatTick: number; // tick within beat (0..ticksPerBeat-1)
  barStartTick: number;
  ticksPerBar: number;
}

/**
 * tick → bar/beat using a time signature (numerator beats / denominator).
 */
export function tickToBarBeat(tick: number, ppq: number, numerator: number, _denomPower: number): BarBeat {
  const beatsPerBar = Math.max(1, numerator);
  const ticksPerBeat = ppq; // quarter note = ppq ticks
  const ticksPerBar = ticksPerBeat * beatsPerBar;
  const beats = tick / ticksPerBeat;
  const barStartBeat = Math.floor(beats / beatsPerBar) * beatsPerBar;
  const beatIndex = Math.floor(beats) % beatsPerBar;
  return {
    bar: Math.floor(beats / beatsPerBar) + 1,
    beat: beatIndex + 1,
    beatTick: Math.floor(tick % ticksPerBeat),
    barStartTick: Math.round(barStartBeat * ticksPerBeat),
    ticksPerBar,
  };
}