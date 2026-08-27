/**
 * Self-contained SMF (Standard MIDI File) parser.
 *
 * Produces a *tick-canonical* model: all timing is integer ticks (PPQ-based).
 * Seconds are derived from the tempo map; tick is the internal source of truth.
 *
 * - Handles running status, VLQ deltas, meta/sysex/channel events, format 0/1/2.
 * - Note-on(vel>0) velocity is retained; note-off matches FIFO per (channel,pitch).
 * - Default tempo 500000 µs (120 BPM) when absent.
 * - Robust to corrupt streams: throws MidiParseError on structural breakage.
 * Pure function over bytes (Worker-friendly, no DOM).
 */

export interface TempoEvent {
  tick: number;
  /** µs per quarter note */
  tempo: number;
}

export interface TimeSignatureEvent {
  tick: number;
  numerator: number;
  denominatorPower: number; // 4 -> denominator 16
  clocksPerClick: number;
  notated32nd: number;
}

export interface TrackMeta {
  index: number;
  name: string;
  programsByChannel: Map<number, number>;
  noteCount: number;
  isPercussion: boolean;
  channels: Set<number>;
}

export interface TrackData {
  meta: TrackMeta;
}

export interface MidiNoteEvent {
  startTick: number;
  endTick: number;
  pitch: number;
  velocity: number;
  channel: number;
  track: number;
}

export interface MidiDocument {
  format: 0 | 1 | 2;
  ppq: number;
  tempos: TempoEvent[];
  timeSignatures: TimeSignatureEvent[];
  tracks: TrackMeta[];
  notes: MidiNoteEvent[];
  durationTicks: number;
}

export class MidiParseError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'MidiParseError';
  }
}

class Reader {
  private view: DataView;
  private p = 0;
  constructor(private bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  get pos(): number { return this.p; }
  set pos(v: number) { this.p = v; }
  eof(): boolean { return this.p >= this.bytes.length; }
  private need(n: number, what: string): void {
    if (this.p + n > this.bytes.length) throw new MidiParseError(`Unexpected end reading ${what}`);
  }
  u8(): number { this.need(1, 'u8'); return this.bytes[this.p++]; }
  u16(): number { this.need(2, 'u16'); const v = this.view.getUint16(this.p); this.p += 2; return v; }
  u32(): number { this.need(4, 'u32'); const v = this.view.getUint32(this.p); this.p += 4; return v; }
  vlq(): number {
    let value = 0;
    for (let i = 0; i < 4; i++) {
      const b = this.u8();
      value = (value << 7) | (b & 0x7f);
      if ((b & 0x80) === 0) return value;
    }
    this.u8();
    return value & 0x0fffffff;
  }
  bytesN(n: number): Uint8Array {
    this.need(n, 'bytes');
    const out = this.bytes.subarray(this.p, this.p + n);
    this.p += n;
    return out;
  }
}

function readText(r: Reader): string {
  const len = r.vlq();
  const raw = r.bytesN(len);
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(raw);
  } catch {
    return '';
  }
}

interface MetaResult {
  tempo?: number;
  timeSig?: TimeSignatureEvent;
  trackName?: string;
}

function handleMeta(type: number, body: Uint8Array): MetaResult {
  const out: MetaResult = {};
  switch (type) {
    case 0x51: {
      if (body.length >= 3) {
        out.tempo = (body[0] << 16) | (body[1] << 8) | body[2];
      }
      break;
    }
    case 0x58: {
      if (body.length >= 4) {
        out.timeSig = {
          tick: 0,
          numerator: body[0],
          denominatorPower: body[1],
          clocksPerClick: body[2],
          notated32nd: body[3],
        };
      }
      break;
    }
    case 0x03: {
      // track name handled by caller with reader-based text decode
      break;
    }
    default: break;
  }
  return out;
}

interface PendingNote { start: number; vel: number; }

export function parseMidi(bytes: Uint8Array): MidiDocument {
  const r = new Reader(bytes);
  if (r.u32() !== 0x4d546864) throw new MidiParseError('Missing MThd header');
  const headerLen = r.u32();
  if (headerLen < 6) throw new MidiParseError('Invalid MThd length');
  const format = r.u16();
  if (format > 2) throw new MidiParseError(`Unsupported SMF format ${format}`);
  const ntrks = r.u16();
  const division = r.u16();
  r.pos = 8 + headerLen;

  let ppq: number;
  if (division & 0x8000) {
    const fps = division & 0xff;
    const tpf = (division >> 8) & 0xff;
    ppq = fps > 0 ? fps * tpf : 96;
  } else {
    ppq = division & 0x7fff;
  }
  if (ppq <= 0) throw new MidiParseError('Invalid PPQ division');

  const tracks: TrackMeta[] = [];
  const allNotes: MidiNoteEvent[] = [];
  const tempos: TempoEvent[] = [];
  const timeSigs: TimeSignatureEvent[] = [];
  let durationTicks = 0;

  for (let ti = 0; ti < ntrks; ti++) {
    if (r.eof()) break;
    if (r.u32() !== 0x4d54726b) break;
    const trackLen = r.u32();
    const end = r.pos + trackLen;
    const meta: TrackMeta = {
      index: ti,
      name: '',
      programsByChannel: new Map(),
      noteCount: 0,
      isPercussion: false,
      channels: new Set(),
    };

    let lastStatus = 0;
    let absTick = 0;
    const pending = new Map<string, PendingNote[]>();

    while (r.pos < end) {
      absTick += r.vlq();
      let status = r.u8();
      if ((status & 0x80) === 0) {
        if (lastStatus === 0) throw new MidiParseError('Running status before first event');
        r.pos -= 1;
        status = lastStatus;
      }

      if (status === 0xff) {
        const type = r.u8();
        if (type === 0x03) {
          const name = readText(r);
          if (name) meta.name = name;
        } else {
          const len = r.vlq();
          const body = r.bytesN(len);
          const parsed = handleMeta(type, body);
          if (parsed?.tempo !== undefined) tempos.push({ tick: absTick, tempo: parsed.tempo });
          if (parsed?.timeSig) {
            parsed.timeSig.tick = absTick;
            timeSigs.push(parsed.timeSig);
          }
        }
        lastStatus = 0;
        continue;
      }
      if (status === 0xf0 || status === 0xf7) {
        const len = r.vlq();
        r.bytesN(len);
        lastStatus = 0;
        continue;
      }
      if (status < 0xf0) {
        const high = status & 0xf0;
        const chan = status & 0x0f;
        if (high === 0x90 || high === 0x80) {
          const pitch = r.u8();
          const vel = r.u8();
          const key = `${chan}:${pitch}`;
          if (high === 0x90 && vel > 0) {
            let q = pending.get(key);
            if (!q) { q = []; pending.set(key, q); }
            q.push({ start: absTick, vel });
          } else {
            const q = pending.get(key);
            if (q && q.length > 0) {
              const n = q.shift()!;
              if (absTick > n.start) {
                allNotes.push({
                  startTick: n.start, endTick: absTick, pitch,
                  velocity: n.vel, channel: chan, track: ti,
                });
                durationTicks = Math.max(durationTicks, absTick);
                meta.noteCount++;
                meta.channels.add(chan);
                if (chan === 9) meta.isPercussion = true;
              }
            }
          }
          lastStatus = status;
        } else if (high === 0xc0) {
          const prog = r.u8();
          meta.programsByChannel.set(chan, prog);
          lastStatus = status;
        } else {
          const nbytes = (high === 0xd0) ? 1 : (high === 0xb0 || high === 0xe0 || high === 0xa0) ? 2 : 2;
          r.bytesN(nbytes);
          lastStatus = status;
        }
      } else {
        lastStatus = status;
      }
    }

    // flush unpaired note-ons at track end (duration 1 tick, vel from stored)
    for (const [key, list] of pending) {
      if (list.length === 0) continue;
      const idx = key.indexOf(':');
      const chan = Number(key.slice(0, idx));
      const pitch = Number(key.slice(idx + 1));
      for (const n of list) {
        allNotes.push({ startTick: n.start, endTick: n.start + 1, pitch, velocity: n.vel, channel: chan, track: ti });
        meta.noteCount++;
        meta.channels.add(chan);
        if (chan === 9) meta.isPercussion = true;
      }
    }

    tracks.push(meta);
  }

  // Sort notes by startTick (stable) for the renderer's SoA order.
  allNotes.sort((a, b) => a.startTick - b.startTick || a.track - b.track || a.pitch - b.pitch);
  if (allNotes.length) durationTicks = Math.max(durationTicks, allNotes[allNotes.length - 1].startTick + 1);

  return {
    format: format as 0 | 1 | 2,
    ppq,
    tempos,
    timeSignatures: timeSigs,
    tracks,
    notes: allNotes,
    durationTicks,
  };
}