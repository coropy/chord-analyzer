import { describe, it, expect } from 'vitest';
import { PresentationClock } from '../src/time/presentationClock';

describe('PresentationClock (uniform-velocity integrator)', () => {
  it('starts at the first raw position', () => {
    const c = new PresentationClock();
    expect(c.update(10, 1000)).toBeCloseTo(10, 6);
    expect(c.last).toBeCloseTo(10, 6);
  });

  it('integrates at a stable velocity with UNIFORM per-frame displacement', () => {
    const c = new PresentationClock();
    // Realistic: getPositionSeconds() advances 1:1 with real time (audio plays
    // at real speed). Feed 1 raw-second per real 1000ms.
    for (let i = 0; i <= 20; i++) {
      c.update(i, i * 1000); // velocity ≈ 1.0 raw/s
    }
    const v = c.velocity;
    expect(v).toBeGreaterThan(0.9);
    expect(v).toBeLessThan(1.1);

    // feed flat raw for many frames (no new audio samples) — the presented
    // values must STILL advance at the same uniform rate each frame.
    const deltas: number[] = [];
    let prev = c.update(20, 21000);
    for (const t of [21010, 21020, 21030, 21040, 21050, 21060, 21070, 21080]) {
      const p = c.update(20, t);
      deltas.push(p - prev);
      prev = p;
    }
    // all deltas positive and nearly uniform (std tiny)
    expect(deltas.every((d) => d > 0)).toBe(true);
    const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    const ss = deltas.reduce((a, b) => a + (b - mean) ** 2, 0) / deltas.length;
    // 10ms frames at 1.0 velocity → 0.01 per frame; std < 2% of mean
    expect(Math.sqrt(ss)).toBeLessThan(mean * 0.02);
    expect(mean).toBeCloseTo(0.01, 3);
  });

  it('never freezes or moves backward while raw is flat', () => {
    const c = new PresentationClock();
    c.update(0, 0);
    c.update(0.06, 120);
    c.update(0.12, 240);
    // raw flat for a long stretch; must keep gliding
    let prev = c.update(0.12, 260);
    for (const t of [280, 300, 320, 340, 360, 380, 400]) {
      const p = c.update(0.12, t);
      expect(p).toBeGreaterThan(prev);
      prev = p;
    }
  });

  it('monotonic guard: a raw sample that lags the presented value does not pull it back', () => {
    const c = new PresentationClock();
    c.update(0, 0);
    c.update(0.1, 200);
    c.update(0.3, 400); // fast rate
    // let it run far ahead
    let prev = c.update(0.3, 500);
    let p = c.update(0.31, 550);
    // 0.31 < presented (which is ahead) → must NOT decrease
    expect(p).toBeGreaterThanOrEqual(prev);
  });

  it('clamps the measured velocity to a sane range', () => {
    const c = new PresentationClock();
    c.update(0, 0);
    // absurd rate sample (would give velocity ~100)
    for (const [t, p] of [[500, 50], [1000, 100], [1500, 150], [2000, 200], [2500, 250]] as const) {
      c.update(p, t);
    }
    // calibrated over span 2500ms → velocity clamped to [0.9, 1.1]
    expect(c.velocity).toBeGreaterThanOrEqual(0.9);
    expect(c.velocity).toBeLessThanOrEqual(1.1);
  });

  it('internals report velocity/calibration span', () => {
    const c = new PresentationClock();
    expect(c.internals()).toBeNull();
    c.update(0, 0);
    c.update(1, 1000);
    c.update(2, 2000);
    const i = c.internals();
    expect(i).not.toBeNull();
    expect(i!.calibN).toBeGreaterThanOrEqual(2);
    expect(i!.calibSpanMs).toBeGreaterThanOrEqual(1000);
  });

  it('reset() clears state', () => {
    const c = new PresentationClock();
    c.update(10, 1000);
    c.update(10.5, 1100);
    c.reset();
    expect(c.internals()).toBeNull();
    expect(c.update(10, 1200)).toBeCloseTo(10, 6);
  });
});