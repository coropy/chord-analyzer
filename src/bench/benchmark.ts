/**
 * Phase 2 renderer benchmark harness.
 *
 * Runs a note count through a driven camera scenario (scroll + zoom + playhead +
 * resize) while measuring frame time, 1%/0.1% lows, CPU update, GPU draw time,
 * and visible notes. Runs each scenario for a duration then reports.
 */
import type { GLNoteRenderer, RenderView } from '../renderer/WebGL2NoteRenderer';
import { FrameTimeHistogram, type FrameStats } from '../perf/frameStats';
import type { NoteSet } from '../renderer/NoteSet';
import { generateNotes } from '../renderer/noteGenerator';

export interface BenchmarkResult {
  count: number;
  scenario: string;
  stats: FrameStats;
  cpuAvgMs: number;
  gpuAvgMs: number;
  avgVisible: number;
  peakVisible: number;
}

export type Scenario = 'idle' | 'play' | 'zoom' | 'alldrive';

/** Camera controller producing a per-frame view for a scenario. */
class ScenarioDriver {
  constructor(private notes: NoteSet) {}

  view(timeMs: number, w: number, h: number, scenario: Scenario): RenderView {
    const t = timeMs / 1000;
    let scrollStartTick = 0;
    let pxPerTick = 0.5;

    switch (scenario) {
      case 'idle': {
        scrollStartTick = 0;
        pxPerTick = 0.5;
        break;
      }
      case 'play': {
        const progress = Math.min(1, t / 45);
        scrollStartTick = progress * this.notes.maxTick;
        pxPerTick = 1.0;
        break;
      }
      case 'zoom': {
        const z = 0.4 + 1.6 * (Math.sin(t * 0.8) * 0.5 + 0.5);
        scrollStartTick = this.notes.maxTick * 0.2;
        pxPerTick = z;
        break;
      }
      case 'alldrive': {
        // playhead + progressive zoom + auto-pan
        const progress = Math.min(1, t / 45);
        const z = 0.3 + (t / 30);
        scrollStartTick = progress * this.notes.maxTick * 0.5;
        pxPerTick = z;
        break;
      }
      default:
        scrollStartTick = 0;
        pxPerTick = 0.5;
    }

    return {
      scrollStartTick,
      pxPerTick,
      topPitch: 88 + 20,
      pxPerPitch: (h - 40) / 88,
      viewportWidth: w,
      viewportHeight: h,
    };
  }
}

export class WebGL2Benchmark {
  private cancelled = false;
  private canvas: HTMLCanvasElement;
  private renderer: GLNoteRenderer;
  private currentNotes: NoteSet | null = null;

  constructor(canvas: HTMLCanvasElement, renderer: GLNoteRenderer) {
    this.canvas = canvas;
    this.renderer = renderer;
  }

  cancel(): void { this.cancelled = true; }

  /** Generate + upload a note set; retained for subsequent runScenario calls. */
  upload(count: number): NoteSet {
    const notes = generateNotes({ count, seed: 999, durationBeats: 480 });
    this.renderer.uploadNotes(notes);
    this.currentNotes = notes;
    return notes;
  }

  /** Run a scenario using the currently uploaded (retained) note set. */
  runScenario(scenario: Scenario, durationMs: number): Promise<BenchmarkResult | null> {
    const notes = this.currentNotes;
    if (!notes) return Promise.resolve(null);
    const hist = new FrameTimeHistogram();
    let cpuAcc = 0, gpuAcc = 0, visibleSum = 0, visiblePeak = 0, frames = 0;
    const driver = new ScenarioDriver(notes);

    return new Promise<BenchmarkResult | null>((resolve) => {
      this.cancelled = false;
      const tStart = performance.now();
      let prev = tStart;

      const loop = (now: number): void => {
        if (this.cancelled) { resolve(null); return; }
        const elapsed = now - tStart;
        if (elapsed >= durationMs) {
          resolve({
            count: notes.count, scenario, stats: hist.computeStats(),
            cpuAvgMs: frames > 0 ? cpuAcc / frames : 0,
            gpuAvgMs: frames > 0 ? gpuAcc / frames : 0,
            avgVisible: frames > 0 ? visibleSum / frames : 0,
            peakVisible: visiblePeak,
          });
          return;
        }
        const frameMs = now - prev;
        prev = now;
        hist.push(frameMs);

        const w = this.canvas.width, h = this.canvas.height;
        const view = driver.view(elapsed, w, h, scenario);

        this.renderer.draw(notes, view);
        cpuAcc += this.renderer.cpuUpdateMs;
        gpuAcc += this.renderer.drawMs;
        visibleSum += this.renderer.lastVisible;
        if (this.renderer.lastVisible > visiblePeak) visiblePeak = this.renderer.lastVisible;
        frames++;
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    });
  }
}