/**
 * Real-time frame telemetry for the "120Hz yet visually juddery" investigation.
 *
 * Per rAF frame we record, in an allocation-free ring buffer:
 *   - performance.now delta (ms)
 *   - AudioContext.currentTime (seconds)
 *   - audio position (seconds)
 *   - playhead tick (float)
 *   - scroll tick (camera)
 *   - first visible grid-line screen X (CSS px)
 *   - first visible MIDI note screen X (CSS px)
 *   - playhead screen X (CSS px)
 *   - browser-reported fps (1 / AVG(total frame delta), min 1)
 *   - nominal display refresh (Hz)
 *   - devicePixelRatio
 *   - GL canvas backing width/height
 *   - GPU draw time (ms)
 *   - CPU update time (ms)
 *
 * The last N frames are summarised: per-timestamp deltas
 * (deltaAudioTick, deltaVisualTick, deltaScrollTick, deltaRAF) report
 * avg/min/max/p1/p99 AND the max frame-to-frame absolute delta (a single
 * jump larger than the median step is the signature of judder).
 *
 * Note-taking is off the hot path: push() allocates nothing; stats() is
 * called from page context on demand.
 */
export interface TickRecord {
  rafMs: number;       // performance.now (ms) of the frame
  audioCtxSec: number; // AudioContext.currentTime
  audioSec: number;    // getPositionSeconds()
  playheadTick: number;
  scrollTick: number;
  gridX: number;
  noteX: number;
  playheadX: number;
  fpsBrowser: number;
  displayHz: number;
  dpr: number;
  backingW: number;
  backingH: number;
  gpuMs: number;
  cpuMs: number;
  uploadBytes: number;
  visible: number;
  /** camera horizontal zoom at this frame (CSS px per tick). */
  pxPerTick: number;
}

export interface TickDeltaStats {
  num: number;
  avg: number;
  min: number;
  max: number;
  p1: number;
  p99: number;
  /** population standard deviation of the deltas. */
  std: number;
  /** max positive deviation from the mean. */
  maxPosDev: number;
  /** max negative deviation from the mean. */
  maxNegDev: number;
  /** max absolute single-frame |delta|. >~2.5x median step => visible jump. */
  maxJump: number;
  medianStep: number;
}

export interface TickStreamSnapshot {
  rafHz: number;
  rafMedianMs: number;
  displayHz: number;
  dpr: number;
  backing: { w: number; h: number };
  audioCtxSec: number;
  audioSec: number;
  playheadTick: number;
  scrollTick: number;
  playheadX: number;
  gridX: number;
  noteX: number;
  gpuMs: number;
  cpuMs: number;
  uploadBytes: number;
  visible: number;
  deltas: {
    audioTick: TickDeltaStats;
    visualTick: TickDeltaStats;
    scrollTick: TickDeltaStats;
    raf: TickDeltaStats;
  };
  /** Screen-space motion uniformity: per-frame playhead X displacement. */
  motion: {
    dx: TickDeltaStats;
    pxPerTick: number;
    /** 3.6667 at 120Hz×440tps → what a uniform motion would produce. */
    theoryDXPerFrame: number;
  };
  monotonic: {
    playhead: boolean;
    scroll: boolean;
    grid: boolean;
    note: boolean;
    playheadX: boolean;
  };
  /** Presentation clock internals (velocity / calibration / tracking err). */
  present: { velocity: number; calibSpanMs: number; calibN: number; err: number };
  /** true if browser-reported fps < 110 with display 120 (visual frame dropping). */
  frameDropHint: boolean;
  notes: string[];
}

export class TickStream {
  private recs: TickRecord[] = [];
  private cap: number;
  /** Presentation internals injected each frame (velocity, calibration). */
  presentInt: { velocity: number; calibSpanMs: number; calibN: number; err: number } | null = null;

  constructor(cap = 480) {
    this.cap = cap;
  }

  reset(): void {
    this.recs.length = 0;
  }

  push(r: TickRecord): void {
    if (this.recs.length >= this.cap) this.recs.shift();
    this.recs.push(r);
  }

  get size(): number {
    return this.recs.length;
  }

  private deltaStats(field: keyof Pick<TickRecord, 'playheadTick' | 'scrollTick' | 'rafMs'>): TickDeltaStats {
    const vals: number[] = [];
    for (let i = 1; i < this.recs.length; i++) {
      const d = (this.recs[i][field] as number) - (this.recs[i - 1][field] as number);
      if (Number.isFinite(d)) vals.push(d);
    }
    return summarize(vals);
  }

  stats(): TickStreamSnapshot {
    const last = this.recs[this.recs.length - 1];
    if (!last) {
      return {
        rafHz: 0, rafMedianMs: 0, displayHz: 0, dpr: 0,
        backing: { w: 0, h: 0 }, audioCtxSec: 0, audioSec: 0,
        playheadTick: 0, scrollTick: 0, playheadX: 0, gridX: 0, noteX: 0,
        gpuMs: 0, cpuMs: 0, uploadBytes: 0, visible: 0,
        deltas: {
          audioTick: emptyStats(), visualTick: emptyStats(), scrollTick: emptyStats(), raf: emptyStats(),
        },
        monotonic: { playhead: true, scroll: true, grid: true, note: true, playheadX: true },
        frameDropHint: false, notes: [],
        motion: {
          dx: emptyStats(),
          pxPerTick: 0,
          theoryDXPerFrame: 0,
        },
        present: { velocity: 0, calibSpanMs: 0, calibN: 0, err: 0 },
      };
    }

    const rafDeltas: number[] = [];
    for (let i = 1; i < this.recs.length; i++) {
      const d = this.recs[i].rafMs - this.recs[i - 1].rafMs;
      if (d > 0 && d < 100) rafDeltas.push(d);
    }
    const rafS = summarize(rafDeltas);
    const rafHz = rafDeltas.length ? 1000 / rafS.avg : 0;
    const rafMedianMs = rafS.medianStep;

    const audioDelta = this.deltaStats('playheadTick');
    // scroll is meaningful while playing; during paused/idle it is flat (ok).
    const scrollDelta = this.deltaStats('scrollTick');
    const rafStats = rafS;

    // Screen-space motion uniformity: deltas of the playhead X (CSS px).
    const dxVals: number[] = [];
    for (let i = 1; i < this.recs.length; i++) {
      const d = this.recs[i].playheadX - this.recs[i - 1].playheadX;
      if (Number.isFinite(d)) dxVals.push(d);
    }
    const dxS = summarize(dxVals);
    const theoryDXPerFrame = last.pxPerTick != null && last.pxPerTick > 0
      ? (last.pxPerTick * 440 / 120) // 440 ticks/s at 120fps
      : 0;

    const dts = {
      audioTick: audioDelta,
      visualTick: audioDelta,      // playhead drives the visuals; same stream
      scrollTick: scrollDelta,
      raf: rafStats,
    };

    const monotonic = {
      playhead: this.isMonotonicNonDecreasing('playheadTick'),
      scroll: this.isMonotonicNonDecreasing('scrollTick'),
      grid: this.noBackwardsJump('gridX'),
      note: this.noBackwardsJump('noteX'),
      playheadX: this.noBackwardsJump('playheadX'),
    };

    const notes: string[] = [];
    if (rafS.medianStep > 0 && audioDelta.medianStep > 0) {
      const stepRatio = audioDelta.maxJump / Math.max(1e-9, audioDelta.medianStep);
      if (stepRatio > 2.5) notes.push(`PLAYHEAD jump >2.5x median step (ratio ${stepRatio.toFixed(1)})`);
    }
    if (scrollDelta.medianStep > 0 && scrollDelta.maxJump / Math.max(1e-9, scrollDelta.medianStep) > 2.5) {
      notes.push('SCROLL jump >2.5x median step');
    }
    if (!monotonic.playhead) notes.push('playhead not monotonic');
    if (!monotonic.scroll) notes.push('scroll not monotonic');
    if (rafS.medianStep > 9.5 && rafS.medianStep < 18) notes.push('rAF at ~60Hz (headless/synthetic clock)');
    if (rafS.medianStep < 9.5) notes.push('rAF at display rate (>=120Hz)');

    const frameDropHint = last.displayHz >= 110 && last.fpsBrowser < 110;

    return {
      rafHz,
      rafMedianMs,
      displayHz: last.displayHz,
      dpr: last.dpr,
      backing: { w: last.backingW, h: last.backingH },
      audioCtxSec: last.audioCtxSec,
      audioSec: last.audioSec,
      playheadTick: last.playheadTick,
      scrollTick: last.scrollTick,
      playheadX: last.playheadX,
      gridX: last.gridX,
      noteX: last.noteX,
      gpuMs: last.gpuMs,
      cpuMs: last.cpuMs,
      uploadBytes: last.uploadBytes,
      visible: last.visible,
      deltas: dts,
      motion: {
        dx: dxS,
        pxPerTick: last.pxPerTick ?? 0,
        theoryDXPerFrame,
      },
      monotonic,
      present: {
        velocity: this.presentInt?.velocity ?? 0,
        calibSpanMs: this.presentInt?.calibSpanMs ?? 0,
        calibN: this.presentInt?.calibN ?? 0,
        err: this.presentInt?.err ?? 0,
      },
      frameDropHint,
      notes,
    };
  }

  private isMonotonicNonDecreasing(field: keyof Pick<TickRecord, 'playheadTick' | 'scrollTick'>): boolean {
    for (let i = 1; i < this.recs.length; i++) {
      if ((this.recs[i][field] as number) < (this.recs[i - 1][field] as number) - 1e-6) return false;
    }
    return true;
  }

  private noBackwardsJump(field: 'gridX' | 'noteX' | 'playheadX'): boolean {
    // X increases while scrolling right (playhead moving). A backwards jump
    // (greater than e.g. -0.75px) marks a discontiguous camera or snapped line.
    for (let i = 1; i < this.recs.length; i++) {
      const d = (this.recs[i][field] as number) - (this.recs[i - 1][field] as number);
      if (d < -0.75) return false;
    }
    return true;
  }
}

function emptyStats(): TickDeltaStats {
  return { num: 0, avg: 0, min: 0, max: 0, p1: 0, p99: 0, std: 0, maxPosDev: 0, maxNegDev: 0, maxJump: 0, medianStep: 0 };
}

function summarize(vals: number[]): TickDeltaStats {
  if (vals.length === 0) return emptyStats();
  const sorted = [...vals].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const avg = sum / vals.length;
  // population std
  let ss = 0;
  for (const v of vals) { const d = v - avg; ss += d * d; }
  const std = Math.sqrt(ss / vals.length);
  let maxPosDev = 0, maxNegDev = 0;
  for (const v of vals) {
    const dev = v - avg;
    if (dev > maxPosDev) maxPosDev = dev;
    if (dev < maxNegDev) maxNegDev = dev;
  }
  let maxJump = 0;
  for (let i = 1; i < vals.length; i++) {
    const j = Math.abs(vals[i] - vals[i - 1]);
    if (j > maxJump) maxJump = j;
  }
  return {
    num: vals.length,
    avg,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    p1: sorted[Math.max(0, Math.floor(0.01 * (sorted.length - 1)))],
    p99: sorted[Math.min(sorted.length - 1, Math.floor(0.99 * (sorted.length - 1)))],
    std,
    maxPosDev,
    maxNegDev,
    maxJump,
    medianStep: sorted[Math.floor(sorted.length / 2)],
  };
}