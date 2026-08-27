import { describe, it, expect } from 'vitest';
import { FrameTimeHistogram } from '../src/perf/frameStats';

describe('FrameTimeHistogram', () => {
  it('computes mean fps and percentiles', () => {
    const h = new FrameTimeHistogram();
    // 100 frames of exactly 10ms
    for (let i = 0; i < 100; i++) h.push(10);
    const s = h.computeStats();
    expect(s.avgMs).toBeCloseTo(10, 3);
    expect(s.avgFps).toBeCloseTo(100, 2);
    expect(s.p1LowMs).toBeCloseTo(10, 3);
    expect(s.p01LowMs).toBeCloseTo(10, 3);
  });

  it('1% low reflects the slow tail', () => {
    const h = new FrameTimeHistogram();
    // 99 normal frames of 5ms, 1 frame of 100ms
    for (let i = 0; i < 99; i++) h.push(5);
    h.push(100);
    const s = h.computeStats();
    expect(s.p1LowMs).toBeGreaterThan(5);
    expect(s.maxMs).toBe(100);
  });
});