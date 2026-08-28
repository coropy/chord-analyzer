/**
 * Musical grid over the tick timeline, driven by a time signature.
 *
 * The "1 bar in N divisions" concept is first-class but NOT hardcoded to 8:
 * the caller picks a `divisionsPerBar`; bar/beat/1-8/1-16/1-32 and arbitrary
 * N-per-bar are all expressible as step ticks.
 *
 * tick is the canonical unit. All boundaries are integer ticks.
 */
import { tickToBarBeat } from './timeline';

export type GridDivisionChoice = 'bar' | 'beat' | '1/8' | '1/16' | '1/32';

export interface GridConfig {
  numerator: number; // beats per bar
  denominatorPower: number; // 2^den
  ppq: number;
  /** e.g. 8 -> an 8-divisions-per-bar grid */
  divisionsPerBar: number;
}

export interface GridLine {
  tick: number;
  kind: 'bar' | 'beat' | 'division';
  bar: number;
  beat: number;
}

export function gridConfig(numerator = 4, denominatorPower = 2, ppq = 480, divisionsPerBar = 8): GridConfig {
  return { numerator, denominatorPower, ppq, divisionsPerBar };
}

/**
 * Coarsen the grid sub-divisions so that adjacent lines stay >= `minDivPx`
 * apart at the given zoom. Steps double (bar/2, bar/4, ...) but never coarser
 * than one bar. Bar/beat-level lines are not subdivided further.
 */
export function adaptiveGridConfig(base: GridConfig, pxPerTick: number, minDivPx = 26): GridConfig {
  const ticksPerBar = barTickSpan(base);
  let divStep = Math.max(1, Math.round(ticksPerBar / Math.max(1, base.divisionsPerBar)));
  while (divStep * pxPerTick < minDivPx && divStep < ticksPerBar) divStep *= 2;
  const effectiveDiv = Math.max(1, Math.round(ticksPerBar / divStep));
  return { ...base, divisionsPerBar: effectiveDiv };
}

/** Pixel spacing of one bar at the given zoom. */
export function barPxSpacing(g: GridConfig, pxPerTick: number): number {
  return barTickSpan(g) * pxPerTick;
}

/** Ticks per bar for the config. */
export function barTickSpan(g: GridConfig): number {
  return g.ppq * g.numerator;
}

/**
 * Enumerate grid lines strictly within [startTick, endTick). Step is aligned to bar starts.
 * Returns a fresh array (used for CPU-side grid culling before GPU upload, not per-frame hot).
 */
export function enumerateGridLines(g: GridConfig, startTick: number, endTick: number): GridLine[] {
  const out: GridLine[] = [];
  const ppq = g.ppq;
  const beatsPerBar = Math.max(1, g.numerator);
  const ticksPerBar = ppq * beatsPerBar;
  const divStep = Math.max(1, Math.round(ticksPerBar / Math.max(1, g.divisionsPerBar)));

  // first bar boundary >= start
  let barStart = Math.floor(startTick / ticksPerBar) * ticksPerBar;
  for (let t = barStart; t < endTick; t += divStep) {
    // skip bar boundary duplicates (they are represented as 'bar')
    // determine kind
    const inBar = ((t % ticksPerBar) + ticksPerBar) % ticksPerBar;
    const bb = tickToBarBeat(t, ppq, beatsPerBar, 2);
    let kind: 'bar' | 'beat' | 'division';
    if (inBar === 0) kind = 'bar';
    else if (inBar % ppq === 0) kind = 'beat';
    else kind = 'division';
    out.push({ tick: t, kind, bar: bb.bar, beat: bb.beat });
    if (inBar !== 0 && inBar + divStep > ticksPerBar) {
      // advance to next bar cleanly
      t += (ticksPerBar - inBar) - divStep; // (adjusted by loop +=)
    }
  }
  return dedupe(out);
}

function dedupe(lines: GridLine[]): GridLine[] {
  const out: GridLine[] = [];
  let last = -1;
  for (const l of lines) {
    if (l.tick === last) continue;
    last = l.tick;
    out.push(l);
  }
  return out;
}