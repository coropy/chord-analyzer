/**
 * Presentation clock: separates the CANONICAL audio position (always from the
 * audio engine — never wall-clock) from a continuously-gliding VISUAL position.
 *
 * Web Audio’s `AudioContext.currentTime` advances on a render-quantum grid
 * (e.g. 128 frames @48kHz ⇒ ~10.7ms steps). At 120Hz the raw playhead therefore
 * steps in batches (4.69 → 4.69 → 3.52 → 0 ticks) because several rAF frames
 * land inside one audio quantum with NO new audio sample. Re-basing the
 * presentation onto each quantized raw sample makes the visual position
 * sawtooth around the raw lattice — every frame moves, but per-frame
 * displacement alternates fast/slow (a 3.5↔4.7-tick rhythm) which reads as
 * motion judder even at 120Hz.
 *
 * This is a UNIFORM-VELOCITY INTEGRATOR:
 *  - it estimates ONE stable velocity v (raw units per real-time second) from
 *    a LONG window of distinct engine samples (least-squares);
 *  - the velocity is re-estimated only after a large calibration window
 *    advances (not every frame), so consecutive rAF frames integrate at a
 *    CONSTANT v:  presented += v · dt(nowMs)
 *    → per-frame displacement is proportional to the stable ~8.33ms interval,
 *    making motion cadence uniform and independent of the quantum lattice;
 *  - a small tracking term steers toward the raw line over ~seconds so long-run
 *    drift is bounded, WITHOUT snapping back to any quantized sample;
 *  - canonical position is NEVER wall-clock; raw is used only for calibration.
 *
 * Invariants:
 *  - monotonic non-decreasing while playing;
 *  - velocity constant across many frames (updated at most every ~1s of span);
 *  - on pause/stop the caller freezes at the engine position.
 */
export const PRESENTATION_MIN_RATE = 0.9;
export const PRESENTATION_MAX_RATE = 1.1;
/** tracking gain: how quickly the integrator steers toward the engine line. */
export const PRESENTATION_TRACK_K = 0.02;
/** calibration keeps samples spanning at least this many ms. */
const CALIB_WINDOW_MS = 40000;
/** velocity is re-estimated only when this much new span has accumulated. */
const REEST_MS = 3000;

export interface PresentationInternals {
  have: boolean;
  /** last presented value (seconds). */
  presented: number;
  /** current velocity (raw units per real second). */
  velocity: number;
  /** calibration span of the velocity estimate (ms). */
  calibSpanMs: number;
  /** LSQ sample count used. */
  calibN: number;
  /** raw engine position (seconds). */
  raw: number;
  /** tracking error (raw − presented), seconds. */
  err: number;
  /** real-time interval of the last integrated frame (ms). */
  lastDtMs: number;
}

export class PresentationClock {
  /** velocity estimate: presented units per real-time second. */
  private v = 1;
  /** last presented value (seconds), integrated monotonically. */
  private presented = 0;
  /** last rAF timestamp seen. */
  private lastNow = 0;
  private have = false;

  // calibration history: ring of (tMs, raw) distinct samples
  private histT: number[] = [];
  private histP: number[] = [];
  private lastRaw = -1;
  private lastReest = 0;
  private lastDtMs = 0;

  reset(): void {
    this.have = false;
    this.v = 1;
    this.presented = 0;
    this.histT.length = 0;
    this.histP.length = 0;
    this.lastRaw = -1;
    this.lastReest = 0;
    this.lastDtMs = 0;
  }

  /** Current measured velocity (presented units per real second). */
  get velocity(): number {
    return this.v;
  }

  /** Raw position is in the caller's native unit (here seconds). */
  update(rawPos: number, nowMs: number): number {
    if (!this.have) {
      this.have = true;
      this.presented = rawPos;
      this.lastNow = nowMs;
      this.lastRaw = rawPos;
      this.histT = [nowMs];
      this.histP = [rawPos];
      this.lastReest = nowMs;
      return this.presented;
    }

    const dt = Math.max(0, (nowMs - this.lastNow) / 1000);
    this.lastDtMs = (nowMs - this.lastNow) || 0;
    this.lastNow = nowMs;

    // accumulate a fresh distinct raw sample
    if (rawPos > this.lastRaw + 1e-9) {
      this.lastRaw = rawPos;
      this.histT.push(nowMs);
      this.histP.push(rawPos);
      while (this.histT.length > 256 ||
             (this.histT.length > 2 && nowMs - this.histT[0] > CALIB_WINDOW_MS)) {
        this.histT.shift();
        this.histP.shift();
      }
    }

    // Re-estimate velocity only after REEST_MS of new span.
    if (this.histT.length >= 2) {
      const span = this.histT[this.histT.length - 1] - this.histT[0];
      if (span > REEST_MS && nowMs - this.lastReest > REEST_MS) {
        let v = lsq(this.histT, this.histP);
        v = Math.min(PRESENTATION_MAX_RATE, Math.max(PRESENTATION_MIN_RATE, v));
        // anti-jitter: only adopt if it moved meaningfully
        this.v = Math.abs(v - this.v) > 0.001 * v ? v : this.v;
        this.lastReest = nowMs;
      }
    }

    // Integrate at the (stable) velocity — uniform cadence.
    let p = this.presented + this.v * dt;
    // Slow tracking toward the raw engine line (never a snap).
    const err = rawPos - p;
    p += PRESENTATION_TRACK_K * err * dt; // seconds-scale correction
    // Monotonic guard.
    if (p < this.presented) p = this.presented;
    this.presented = p;
    return p;
  }

  /** Diagnostics: internal state (no allocation in the hot path except this call). */
  internals(): PresentationInternals | null {
    if (!this.have) return null;
    const n = this.histT.length;
    return {
      have: true,
      presented: this.presented,
      velocity: this.v,
      calibSpanMs: n >= 2 ? this.histT[n - 1] - this.histT[0] : 0,
      calibN: n,
      raw: this.lastRaw,
      err: this.lastRaw - this.presented,
      lastDtMs: this.lastDtMs,
    };
  }

  /** Last presented position (seconds). */
  get last(): number {
    return this.have ? this.presented : 0;
  }
}

/** Least-squares slope over (tMs, p) pairs, in raw units per real second. */
function lsq(t: number[], p: number[]): number {
  const n = t.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const x = t[i], y = p[i];
    sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  const den = n * sxx - sx * sx;
  if (Math.abs(den) < 1e-9) return 1;
  // slope in raw units per ms; convert to raw units per real second.
  return ((n * sxy - sx * sy) / den) * 1000;
}