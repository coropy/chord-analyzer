import { describe, it, expect } from 'vitest';
import {
  buildTempoMap, tickToSeconds, secondsToTick, tickToBarBeat,
} from '../src/time/timeline';
import { gridConfig, barTickSpan, enumerateGridLines } from '../src/time/grid';
import { xToTick, tickToX, makeCamera } from '../src/time/camera';
import { parseMidi } from '../src/midi/MidiParser';

function doc(ppq = 480, durationTicks = 1920, tempo = 500000) {
  return {
    format: 0 as 0, ppq, tempos: [{ tick: 0, tempo }], timeSignatures: [],
    tracks: [], notes: [], durationTicks,
  };
}

describe('tick→seconds (constant tempo)', () => {
  it('one beat at 120bpm = 0.5s', () => {
    const map = buildTempoMap(doc(480, 1920, 500000));
    expect(tickToSeconds(map, 480)).toBeCloseTo(0.5, 6);
  });
  it('four beats = 2s (one bar 4/4)', () => {
    const map = buildTempoMap(doc(480, 1920, 500000));
    expect(tickToSeconds(map, 1920)).toBeCloseTo(2.0, 5);
  });
  it('inverse round-trips', () => {
    const map = buildTempoMap(doc(480, 1920, 500000));
    for (const s of [0, 0.25, 0.5, 1.0, 1.9]) {
      const t = secondsToTick(map, s);
      expect(tickToSeconds(map, t)).toBeCloseTo(s, 3);
    }
  });
  it('variable tempo: double after 2s boundary', () => {
    const map = buildTempoMap({
      format: 0, ppq: 480, tempos: [{ tick: 0, tempo: 500000 }, { tick: 960, tempo: 1000000 }],
      timeSignatures: [], tracks: [], notes: [], durationTicks: 2400,
    });
    // up to 960 ticks at 0.5s/beat ≈ 1.0s; then 1s/beat
      expect(tickToSeconds(map, 960)).toBeCloseTo(1.0, 4);
      expect(tickToSeconds(map, 960 + 480)).toBeCloseTo(2.0, 4); // 1.0 + 1 beat at 1s
  });
});

describe('tick → bar/beat', () => {
  it('4/4: tick 0 = bar1 beat1', () => {
    const bb = tickToBarBeat(0, 480, 4, 2);
    expect(bb.bar).toBe(1); expect(bb.beat).toBe(1); expect(bb.beatTick).toBe(0);
  });
  it('tick 480 = bar1 beat2', () => {
    const bb = tickToBarBeat(480, 480, 4, 2);
    expect(bb.bar).toBe(1); expect(bb.beat).toBe(2);
  });
  it('tick 1920 = bar2 beat1', () => {
    const bb = tickToBarBeat(1920, 480, 4, 2);
    expect(bb.bar).toBe(2); expect(bb.beat).toBe(1);
  });
});

describe('grid', () => {
  it('1 bar = 8 divisions (ppq 480) → 8 lines + bar boundary', () => {
    const g = gridConfig(4, 2, 480, 8);
    expect(barTickSpan(g)).toBe(1920);
    const lines = enumerateGridLines(g, 0, 1920);
    expect(lines.length).toBeGreaterThanOrEqual(8);
    expect(lines[0].kind).toBe('bar');
    expect(lines[0].tick).toBe(0);
    expect(lines.some((l) => l.kind === 'division')).toBe(true);
    // every line tick multiple of 240 (1920/8)
    for (const l of lines) expect(l.tick % 240).toBe(0);
  });
  it('change divisions to 16 → 16 lines per bar', () => {
    const g = gridConfig(4, 2, 480, 16);
    const lines = enumerateGridLines(g, 0, 1920);
    expect(lines.length).toBe(16);
  });
});

describe('camera tick↔x', () => {
  it('round-trips', () => {
    const c = makeCamera({ scrollTick: 1000, pxPerTick: 0.5, topPitch: 60, pxPerPitch: 4 });
    for (const x of [0, 100, 500]) {
      const t = xToTick(c, x);
      expect(tickToX(c, t)).toBeCloseTo(x, 3);
    }
  });
});

describe('parser on tiny fixture', () => {
  it('parses a minimal note-on/off pair', () => {
    const hdr = new Uint8Array([0x4d,0x54,0x68,0x64, 0,0,0,6, 0,0, 0,1, 0x01,0xe0]);
    // track events: delta0 note-on ch0 pitch60 vel100 ; vlq(480)=0x83,0x60 ; note-off
    const trackBody = [
      0x00, 0x90, 60, 100,
      0x83, 0x60,
      0x80, 60, 0,
      0x00, 0xff, 0x2f, 0x00,
    ];
    const len = trackBody.length;
    const mtrk = [0x4d,0x54,0x72,0x6b, (len>>24)&255,(len>>16)&255,(len>>8)&255, len&255];
    const bytes = new Uint8Array(hdr.length + mtrk.length + trackBody.length);
    bytes.set(hdr, 0);
    bytes.set(mtrk, hdr.length);
    bytes.set(trackBody, hdr.length + mtrk.length);
    const m = parseMidi(bytes);
    expect(m.ppq).toBe(480);
    expect(m.notes.length).toBe(1);
    expect(m.notes[0].startTick).toBe(0);
    expect(m.notes[0].endTick).toBe(480);
    expect(m.notes[0].velocity).toBe(100);
  });
});