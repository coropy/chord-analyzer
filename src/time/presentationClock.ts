/**
 * Presentation clock: separates the CANONICAL audio position (always from the
 * audio engine — never wall-clock) from a continuously-gliding VISUAL position.
 *
 * Web Audio’s `AudioContext.currentTime` advances on a render-quantum grid
 * (e.g. 128 frames @48kHz = 5.33ms, often observable as ~10.7ms steps). At
 * 120Hz the playhead therefore steps in batches (4.69 → 4.69 → 3.52 → 0 ticks)
 * because several rAF frames land inside one audio quantum with **no** new
 * audio sample. The camera/notes/grid are all derived 1:1 from the playhead,
 * so the whole picture stutters every 3rd–4th frame.
 *
 * This class keeps the audio engine as the source of truth. It uses real time
 * ONLY to extrapolate forward from the most recent distinct audio sample at a
 * rate close to real time (audio plays at ~1.0× real time, so between two
 * quanta the position should advance ~elapsed-real-time × 1.0). The
 * extrapolated value therefore glides within a quantum instead of stepping in
 * quantum-sized chunks.
 *
 * Units: position is in the caller's native unit (here SECONDS from the
 * engine). Rates are expressed as multiples of real time (1.0 = real time).
 *
 * Invariants:
 *  - canonical position is NEVER replaced by wall-clock;
 *  - the presented value is never lower than the previous presented value
 *    (monotonic non-decreasing while playing);
 *  - a new distinct audio sample that is >= the current presented value joins
 *    the extrapolation continuously (no backward snap); a sample that lags is
 *    absorbed by the monotonic guard until the extrapolation catches up;
 *  - when playing stops, the caller freezes at the engine position.
 */
export const PRESENTATION_MIN_RATE = 0.75;
export const PRESENTATION_MAX_RATE = 1.25;

export class PresentationClock {
  /** last distinct audio sample: time (ms) and position (seconds) */
  private tS = 0;
  private pS = 0;
  /** measured real-time factor (1.0 == plays at real time) */
  private rate = 1;
  private lastRawPos = 0;
  private have = false;
  /** last presented value (monotonic guard) */
  private lastPresented = 0;

  reset(): void {
    this.have = false;
    this.rate = 1;
    this.lastPresented = 0;
  }

  /**
   * Feed the latest raw engine position every frame.
   * `nowMs` is the rAF timestamp (performance.now domain), used ONLY to
   * extrapolate between audio samples — never as a position source.
   */
  update(rawPos: number, nowMs: number): number {
    if (!this.have) {
      this.have = true;
      this.tS = nowMs; this.pS = rawPos;
      this.lastRawPos = rawPos;
      this.lastPresented = rawPos;
      return rawPos;
    }

    // Is this a new distinct, later sample?
    const dt = nowMs - this.tS;
    if (rawPos > this.lastRawPos + 1e-9 && dt > 1e-3) {
      // Update the measured real-time factor (single exponential follow).
      const intervalSec = Math.max(1e-3, dt / 1000);
      const r = (rawPos - this.lastRawPos) / intervalSec;
      if (r >= PRESENTATION_MIN_RATE && r <= PRESENTATION_MAX_RATE) {
        this.rate = this.rate === 1 ? r : this.rate * 0.5 + r * 0.5;
      }
      this.lastRawPos = rawPos;
      this.tS = nowMs; this.pS = rawPos;
    }

    // Extrapolate from the last distinct sample at the measured real-time
    // factor. While raw is flat (between quanta) this glides forward at ~1.0×
    // real time. The monotonic clamp absorbs rare discontinuities (seek/pause)
    // so the presented value never moves backward.
    const elapsed = Math.max(0, (nowMs - this.tS) / 1000);
    const presented = this.pS + this.rate * elapsed;
    const out = Math.max(presented, this.lastPresented);
    this.lastPresented = out;
    return out;
  }

  /** Last presented position (no wall-clock extrapolation). */
  get last(): number {
    return this.have ? this.lastPresented : 0;
  }
}