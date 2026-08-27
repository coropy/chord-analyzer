/**
 * Quantization of ticks onto a musical grid.
 *
 * The canonical time unit is tick. Quantization maps a raw tick onto the
 * nearest grid boundary. Supported divisions:
 *   - quarter note (1/4)
 *   - eighth  (1/8)
 *   - sixteenth (1/16)
 *   - thirty-second (1/32)
 *   - "1 bar / N divisions" (arbitrary N, NOT hardcoded to 8)
 *
 * Quantization NEVER mutates the raw tick — it always returns a new
 * quantizedTick so the raw value is preserved across quantize toggles.
 */
export type QuantizeDivision =
  | '1/4' | '1/8' | '1/16' | '1/32'          // per quarter-note subdivisions
  | { barDivisions: number };                 // 1 bar / N divisions

export interface QuantizeContext {
  ppq: number;          // clocks per quarter note
  numerator: number;    // beats per bar (time signature top)
}

/**
 * Grid step in ticks for a division under the given context.
 * ticksPerBeat = ppq.
 *   1/4  -> ppq
 *   1/8  -> ppq/2
 *   1/16 -> ppq/4
 *   1/32 -> ppq/8
 *   bar/N -> (ppq * numerator) / N
 */
export function divisionStepTicks(div: QuantizeDivision, ctx: QuantizeContext): number {
  const ppq = Math.max(1, ctx.ppq);
  let step: number;
  if (div === '1/4') step = ppq;
  else if (div === '1/8') step = ppq / 2;
  else if (div === '1/16') step = ppq / 4;
  else if (div === '1/32') step = ppq / 8;
  else {
    const n = Math.max(1, Math.round(div.barDivisions));
    const ticksPerBar = ppq * Math.max(1, ctx.numerator);
    step = ticksPerBar / n;
  }
  return Math.max(1, Math.round(step));
}

/**
 * Quantize a raw tick to the nearest step boundary.
 * Returns `{ rawTick, quantizedTick }` where rawTick is preserved unchanged.
 */
export function quantizeTick(
  rawTick: number,
  div: QuantizeDivision,
  ctx: QuantizeContext,
): { rawTick: number; quantizedTick: number } {
  const step = divisionStepTicks(div, ctx);
  const raw = Math.max(0, Math.round(rawTick));
  const q = Math.max(0, Math.round(raw / step) * step);
  return { rawTick: rawTick, quantizedTick: q };
}

/** Human label for a division (used by debug / dropdown). */
export function divisionLabel(div: QuantizeDivision): string {
  if (div === '1/4') return '1/4';
  if (div === '1/8') return '1/8';
  if (div === '1/16') return '1/16';
  if (div === '1/32') return '1/32';
  return `bar/${div.barDivisions}`;
}

export const DEFAULT_DIVISION: QuantizeDivision = { barDivisions: 8 };

/**
 * Enumerate all quantize options in a stable order (quarter...32nd, then bar/N).
 */
export function quantizeOptions(opts: { barDivisions?: number } = {}): { value: QuantizeDivision; label: string }[] {
  const fixed: QuantizeDivision[] = ['1/4', '1/8', '1/16', '1/32'];
  const list = fixed.map((d) => ({ value: d, label: divisionLabel(d) }));
  const n = opts.barDivisions ?? 8;
  list.push({ value: { barDivisions: n }, label: `1 bar / ${n}` });
  return list;
}