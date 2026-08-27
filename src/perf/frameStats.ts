/** Frame statistics: avg, 1% low, 0.1% low, percentiles over frame times. */

export interface FrameStats {
  frames: number;
  avgFps: number;
  /** avg frame time in ms */
  avgMs: number;
  /** 1% low frame time (ms). Frames slower than this occur only 1% of the time. */
  p1LowMs: number;
  /** 0.1% low frame time (ms). */
  p01LowMs: number;
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
}

/** Rolling ring buffer of frame times. Preallocated; no allocation in the hot path (except analysis). */
export class FrameTimeHistogram {
  private times: Float64Array;
  private index = 0;
  private count = 0;

  constructor(capacity = 8192) {
    this.times = new Float64Array(capacity);
  }

  reset(): void {
    this.index = 0;
    this.count = 0;
  }

  /** Record a frame time in ms. */
  push(ms: number): void {
    this.times[this.index] = ms;
    this.index = (this.index + 1) % this.times.length;
    if (this.count < this.times.length) this.count++;
  }

  /** Copy raw sample values (allocates a snapshot for analysis only). */
  snapshot(): Float64Array {
    const out = new Float64Array(this.count);
    if (this.count === 0) return out;
    const start = this.count < this.times.length ? 0 : this.index;
    for (let i = 0; i < this.count; i++) {
      out[i] = this.times[(start + i) % this.times.length];
    }
    return out;
  }

  private p(frac: number): number {
    const n = this.count;
    if (n === 0) return 0;
    const arr = [...this.snapshot()].sort((a, b) => a - b);
    const idx = Math.floor(frac * (n - 1));
    return arr[Math.max(0, Math.min(n - 1, idx))];
  }

  /** Low-percentile frame time: only pct% of frames are slower than this. e.g. 1 → 1% low. */
  lowK(pct: number): number {
    const n = this.count;
    if (n === 0) return 0;
    const arr = [...this.snapshot()].sort((a, b) => a - b);
    // Worst pct% of frames: take the (1 - pct/100)-th frame from the fast end,
    // i.e. the frame only pct% are slower than.
    const idx = Math.min(n - 1, Math.floor((1 - pct / 100) * n));
    return arr[Math.max(0, idx)];
  }

  mean(): number {
    if (this.count === 0) return 0;
    let s = 0;
    for (let i = 0; i < this.count; i++) s += this.times[i];
    return s / this.count;
  }

  max(): number {
    let m = 0;
    for (let i = 0; i < this.count; i++) if (this.times[i] > m) m = this.times[i];
    return m;
  }

  get size(): number {
    return this.count;
  }

  computeStats(): FrameStats {
    return {
      frames: this.count,
      avgFps: this.count ? 1000 / this.mean() : 0,
      avgMs: this.mean(),
      p1LowMs: this.lowK(1),
      p01LowMs: this.lowK(0.1),
      p50Ms: this.p(0.5),
      p99Ms: this.p(0.99),
      maxMs: this.max(),
    };
  }
}