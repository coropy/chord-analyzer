import { describe, it, expect } from 'vitest';
import {
  divisionStepTicks, quantizeTick, divisionLabel, quantizeOptions, DEFAULT_DIVISION,
} from '../src/marker/quantize';
import {
  makeMarker, requantize, buildRegions, effectiveTick, ctx480, type QuantizeLayout,
} from '../src/marker/marker';
import { CommandEngine } from '../src/marker/history';

const on: QuantizeLayout = { enabled: true, division: DEFAULT_DIVISION };
const off: QuantizeLayout = { enabled: false, division: DEFAULT_DIVISION };

describe('quantizeTick', () => {
  const ctx = ctx480; // ppq 480, 4/4

  it('1/8 quantizes a raw tick to the 240 boundary', () => {
    expect(divisionStepTicks('1/8', ctx)).toBe(240);
    const { rawTick, quantizedTick } = quantizeTick(251, '1/8', ctx);
    expect(rawTick).toBe(251);       // raw preserved
    expect(quantizedTick).toBe(240); // nearest 240 boundary
  });

  it('1/4 quantizes to 480 boundaries', () => {
    expect(divisionStepTicks('1/4', ctx)).toBe(480);
    expect(quantizeTick(700, '1/4', ctx).quantizedTick).toBe(480);
    expect(quantizeTick(760, '1/4', ctx).quantizedTick).toBe(960);
  });

  it('1/16 and 1/32 produce the expected steps', () => {
    expect(divisionStepTicks('1/16', ctx)).toBe(120);
    expect(divisionStepTicks('1/32', ctx)).toBe(60);
  });

  it('bar/8 divisions = 240 for 4/4 ppq 480', () => {
    expect(divisionStepTicks({ barDivisions: 8 }, ctx)).toBe(240);
  });

  it('bar/16 is half of bar/8', () => {
    expect(divisionStepTicks({ barDivisions: 16 }, ctx)).toBe(120);
  });

  it('negative raw clamps quantized to 0 and preserves raw', () => {
    const { rawTick, quantizedTick } = quantizeTick(-5, '1/8', ctx);
    expect(rawTick).toBe(-5);
    expect(quantizedTick).toBe(0);
  });

  it('rawTick is never mutated', () => {
    const raw = 59;
    expect(quantizeTick(raw, '1/16', ctx).rawTick).toBe(raw);
    expect(quantizeTick(raw + 5, '1/16', ctx).rawTick).toBe(raw + 5);
  });

  it('division label for bar/N', () => {
    expect(divisionLabel({ barDivisions: 8 })).toBe('bar/8');
    expect(divisionLabel('1/8')).toBe('1/8');
  });

  it('quantizeOptions lists 5 standard entries', () => {
    const o = quantizeOptions();
    expect(o).toHaveLength(5);
    expect(o.map((x) => x.label)).toEqual(['1/4', '1/8', '1/16', '1/32', '1 bar / 8']);
  });
});

describe('makeMarker + requantize', () => {
  it('preserves rawTick, derives quantizedTick when enabled', () => {
    const m = makeMarker(1, 251, on);
    expect(m.rawTick).toBe(251);
    expect(m.quantizedTick).toBe(240);
    expect(m.quantizeEnabled).toBe(true);
  });

  it('when disabled quantizedTick equals rawTick', () => {
    const m = makeMarker(2, 1300, off);
    expect(m.quantizedTick).toBe(1300);
    expect(m.quantizeEnabled).toBe(false);
  });

  it('requantize recomputes from raw without duplicating raw', () => {
    const m = makeMarker(1, 701, off);
    const q = requantize(m, on);
    expect(q.rawTick).toBe(701);
    expect(q.quantizedTick).toBe(720);
  });
});

describe('buildRegions', () => {
  it('builds regions between adjacent markers', () => {
    const ms = [makeMarker(1, 0, on), makeMarker(2, 480, on), makeMarker(3, 960, on)];
    const regions = buildRegions(ms);
    expect(regions).toHaveLength(2);
    expect(regions[0].startMarkerId).toBe(1);
    expect(regions[0].endMarkerId).toBe(2);
    expect(regions[0].startTick).toBe(0);
    expect(regions[0].endTick).toBe(480);
    expect(regions[1].startMarkerId).toBe(2);
    expect(regions[1].endMarkerId).toBe(3);
  });

  it('handles markers added out of order', () => {
    const ms = [makeMarker(1, 960, on), makeMarker(2, 0, on), makeMarker(3, 480, on)];
    const regions = buildRegions(ms);
    expect(regions).toHaveLength(2);
    expect(regions[0].startTick).toBe(0);
    expect(regions[0].endTick).toBe(480);
  });

  it('fewer than two markers yields no regions', () => {
    expect(buildRegions([])).toHaveLength(0);
    expect(buildRegions([makeMarker(1, 0, on)])).toHaveLength(0);
  });

  it('effectiveTick honors per-marker quantizeEnabled', () => {
    const offM = makeMarker(1, 1300, off);
    const onM = makeMarker(2, 251, on);
    expect(effectiveTick(offM)).toBe(1300);
    expect(effectiveTick(onM)).toBe(240);
  });
});

describe('CommandEngine (undo/redo)', () => {
  it('add, undo, redo', () => {
    const e = new CommandEngine();
    e.addMarker(100);
    expect(e.markers).toHaveLength(1);
    expect(e.undo()).toBe(true);
    expect(e.markers).toHaveLength(0);
    expect(e.redo()).toBe(true);
    expect(e.markers).toHaveLength(1);
  });

  it('delete then undo restores the marker', () => {
    const e = new CommandEngine();
    const m = e.addMarker(100);
    expect(e.deleteMarker(m.id)).toBe(true);
    expect(e.markers).toHaveLength(0);
    expect(e.undo()).toBe(true);
    expect(e.markers).toHaveLength(1);
    expect(e.markers[0].rawTick).toBe(100);
  });

  it('move recomputes quantized and undo restores', () => {
    const e = new CommandEngine();
    const m = e.addMarker(251);
    expect(m.quantizedTick).toBe(240);
    e.moveMarker(m.id, 470);
    const moved = e.markers.find((x) => x.id === m.id)!;
    expect(moved.rawTick).toBe(470);
    expect(moved.quantizedTick).toBe(480);
    expect(e.undo()).toBe(true);
    const undone = e.markers.find((x) => x.id === m.id)!;
    expect(undone.rawTick).toBe(251);
    expect(undone.quantizedTick).toBe(240);
  });

  it('setLayout requantizes; undo restores prior division and ticks', () => {
    const e = new CommandEngine();
    e.addMarker(251); // quantize on, default bar/8 -> 240
    expect(e.markers[0].quantizedTick).toBe(240);
    e.setLayout({ enabled: true, division: '1/4' });
    expect(e.markers[0].quantizedTick).toBe(480); // 251 -> nearest 1/4 boundary
    expect(e.undo()).toBe(true);
    expect(e.markers[0].quantizedTick).toBe(240);
  });
});