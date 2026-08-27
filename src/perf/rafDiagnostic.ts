/**
 * requestAnimationFrame timing diagnostic.
 *
 * Distinguishes display-driven rAF (real monitor vertical refresh) from the
 * fake frame clock used by headless / offscreen renderers. In a 120Hz-monitored
 * headed browser, consecutive rAF deltas cluster around ~8.33ms; in headless
 * Chromium with `--run-all-compositor-stages-before-draw` unset, deltas are
 * often ~16.7ms (a synthetic 60Hz) or jittery.
 *
 * This is informational only: it is NOT used to infer renderer failure. Phase 2
 * already confirmed 120Hz frame pacing on a real GPU; the browser-vs-headless
 * difference is expected on this machine.
 */
export interface RaftStats {
  observedHz: number;      // 1000 / average delta
  medianMs: number;
  p95Ms: number;
  sampleCount: number;
  notes: string;
}

const MAX_RECORDS = 240;

/**
 * Start sampling rAF deltas. Returns a handle with `stats()` (latest) and
 * `stop()`. Callback-free: caller polls stats().
 */
export function startRafProbe(): { stats: () => RaftStats; stop: () => void } {
  const deltas: number[] = [];
  let last = performance.now();
  let rafId = 0;
  let running = true;

  const loop = (now: number): void => {
    if (!running) return;
    const d = now - last; last = now;
    if (d > 0 && d < 100) deltas.push(d);
    if (deltas.length > MAX_RECORDS) deltas.shift();
    rafId = requestAnimationFrame(loop);
  };
  rafId = requestAnimationFrame(loop);

  return {
    stop: () => { running = false; cancelAnimationFrame(rafId); },
    stats: () => {
      if (deltas.length === 0) {
        return { observedHz: 0, medianMs: 0, p95Ms: 0, sampleCount: 0, notes: 'no samples yet' };
      }
      const sorted = [...deltas].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
      const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
      return {
        observedHz: 1000 / avg,
        medianMs: Number(median.toFixed(2)),
        p95Ms: Number(p95.toFixed(2)),
        sampleCount: deltas.length,
        notes: describe(median),
      };
    },
  };
}

function describe(medianMs: number): string {
  if (medianMs < 10.5) return 'display-driven rAF (~display refresh >60Hz)';
  if (medianMs < 18) return 'synthetic ~60Hz rAF (typical headless/offscreen)';
  return 'irregular rAF (VSync off / blocked main thread)';
}