import { describe, it, expect } from 'vitest';
import { PresentationClock } from '../src/time/presentationClock';

describe('PresentationClock', () => {
  it('starts at the first raw position', () => {
    const c = new PresentationClock();
    expect(c.update(10, 1000)).toBeCloseTo(10, 6);
    expect(c.last).toBeCloseTo(10, 6);
  });

  it('idle/paused: caller resets and freezes (no extrapolation drift)', () => {
    const c = new PresentationClock();
    c.update(10, 1000);
    c.reset();
    // After reset, a constant raw feed yields a constant presentation
    expect(c.update(10, 1083)).toBeCloseTo(10, 6);
  });

  it('maintains continuity: a new sample joins the presentation without a backward snap', () => {
    const c = new PresentationClock();
    c.update(0, 0);
    // audio quantum: raw steps 0.0107s per 10.7ms real → rate ≈ 1.0
    c.update(0.0107, 10.7);
    // between samples at 13ms the extrapolation leads slightly
    const v1 = c.update(0.0107, 13);
    expect(v1).toBeGreaterThanOrEqual(0.0107);
    // new distinct sample at 21.3ms (raw 0.0213)
    const v2 = c.update(0.0213, 21.3);
    // must not move backward
    expect(v2).toBeGreaterThanOrEqual(v1 - 1e-9);
    // and should be close to the (extrapolated) line: within ~1 quantum
    expect(Math.abs(v2 - 0.0213)).toBeLessThan(0.035);
  });

  it('glides smoothly between audio samples (rate ~1.0 real time)', () => {
    const c = new PresentationClock();
    c.update(0, 0);
    c.update(0.0107, 10.7); // ~1.0x real time
    c.update(0.0213, 21.3);
    // between samples: presentation should advance ~1.0 * elapsed
    const v1 = c.update(0.0213, 25);
    expect(v1).toBeGreaterThan(0.0213);
    const v2 = c.update(0.0213, 29);
    expect(v2).toBeGreaterThan(v1);
    const v3 = c.update(0.0213, 33);
    expect(v3).toBeGreaterThan(v2);
    // next distinct sample arrives; joins without backward
    const v4 = c.update(0.032, 32.0);
    expect(v4).toBeGreaterThanOrEqual(v3 - 1e-9);
  });

  it('clamps the measured rate to a sane range', () => {
    const c = new PresentationClock();
    c.update(0, 0);
    // absurd rate sample (would give rate 100)
    c.update(100, 1000);
    c.update(100, 1500);
    const v = c.update(100, 1600);
    // rate clamped to max 1.25 → extrapolate ~100 + 1.25*0.6
    expect(v).toBeLessThan(102);
    expect(v).toBeGreaterThan(100);
  });

  it('never freezes at zero advancement once motion is underway', () => {
    const c = new PresentationClock();
    c.update(0, 0);
    // real 120fps: audio raw advances ~0.0107s per real 10.7ms quantum.
    // between quanta the presentation must still advance each rAF frame.
    c.update(0.0107, 10.7);
    c.update(0.0213, 21.3);
    let prev = c.update(0.0213, 25);
    for (const t of [29, 33, 37, 41]) {
      const v = c.update(0.0213, t);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
  });
});