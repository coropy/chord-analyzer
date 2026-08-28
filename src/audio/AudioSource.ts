/**
 * Audio timeline source abstraction.
 *
 * Canonical playback position always comes from the audio engine's own clock
 * (AudioContext.currentTime / position-aware scheduling), NEVER from wall-clock
 * or performance.now(). WAV and future MIDI-synth sources share this contract.
 */
export interface AudioSnapshot {
  positionSeconds: number;
  playing: boolean;
  durationSeconds: number;
}

export interface AudioTimelineSource {
  load(): Promise<void>;
  play(): void;
  pause(): void;
  stop(): void;
  seek(seconds: number): void;
  /** Latest position read from the engine (not wall-clock). */
  getPositionSeconds(): number;
  getSnapshot(): AudioSnapshot;
  readonly duration: number;
  readonly loaded: boolean;
  readonly playing: boolean;
  onEnded?: () => void;
}

/**
 * WAV source backed by Web Audio.
 *
 * Position is derived from AudioContext.currentTime relative to a scheduled
 * start, corrected by outputLatency so reported position matches what is
 * physically at the speakers. No wall-clock is involved in position math.
 */
export class WavAudioSource implements AudioTimelineSource {
  onEnded?: () => void;

  private ctx: AudioContext | null = null;
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  /** seconds offset into the buffer at playback start (last seek/pause base) */
  private baseOffset = 0;
  /** ctx.currentTime at which the buffer was scheduled to start */
  private scheduledAt = 0;
  private _playing = false;

  get playing(): boolean { return this._playing; }
  set playing(v: boolean) { this._playing = v; }

  constructor(private arrayBuffer: ArrayBuffer) {
    // decode deferred to load()
  }

  private ensureCtx(): AudioContext {
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'interactive' });
    return this.ctx;
  }

  async load(): Promise<void> {
    const ctx = this.ensureCtx();
    // resume is best-effort (may be suspended without a user gesture in headless);
    // do not block decode on it.
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => { /* noop */ });
    }
    const copy = this.arrayBuffer.slice(0);
    this.buffer = await ctx.decodeAudioData(copy);
  }

  /** Position of the NEXT audio block, i.e. what the engine will output now. */
  private clockPosition(): number {
    if (!this.ctx) return this.baseOffset;
    if (!this.playing || !this.source) return this.baseOffset;
    const now = this.ctx.currentTime;
    return this.baseOffset + (now - this.scheduledAt) - this.outputLatencyOf();
  }

  private outputLatencyOf(): number {
    return this.ctx!.outputLatency || 0;
  }

  private spawn(): void {
    const ctx = this.ctx!;
    const source = ctx.createBufferSource();
    source.buffer = this.buffer;
    const gain = ctx.createGain();
    gain.gain.value = 1;
    source.connect(gain);
    gain.connect(ctx.destination);
    source.onended = () => {
      // Only the CURRENT source may mutate state. A stopped/replaced source's
      // onended fires later and must not clobber a newer source (e.g. after a
      // playback seek), otherwise playback appears to stop while audio flows on.
      if (this.source !== source) return;
      this.source = null;
      if (this.playing) this.playing = false;
      this.onEnded?.();
    };
    this.source = source;
  }

  play(): void {
    if (!this.buffer || !this.ctx) return;
    const ctx = this.ctx;
    if (ctx.state === 'suspended') void ctx.resume();
    if (this.source) this.source.stop();
    this.spawn();
    // schedule slightly ahead to absorb timer jitter; record the ctx-time it starts.
    this.scheduledAt = ctx.currentTime + 0.05;
    this.source!.start(this.scheduledAt, this.baseOffset);
    this.playing = true;
  }

  pause(): void {
    if (!this.playing || !this.source || !this.ctx) return;
    // baseOffset advances to current audio position (from engine clock, not wall).
    this.baseOffset = Math.max(0, Math.min(this.duration, this.clockPosition()));
    this.source.stop();
    this.source = null;
    this.playing = false;
  }

  stop(): void {
    if (this.source) { this.source.stop(); this.source = null; }
    this.baseOffset = 0;
    this.playing = false;
  }

  seek(seconds: number): void {
    this.baseOffset = Math.max(0, Math.min(this.duration, seconds));
    if (this.playing) {
      this.source?.stop();
      this.source = null;
      this.spawn();
      const ctx = this.ctx!;
      this.scheduledAt = ctx.currentTime + 0.05;
      this.source!.start(this.scheduledAt, this.baseOffset);
    }
  }

  getPositionSeconds(): number {
    return Math.max(0, Math.min(this.duration, this.clockPosition()));
  }

  getSnapshot(): AudioSnapshot {
    return { positionSeconds: this.getPositionSeconds(), playing: this.playing, durationSeconds: this.duration };
  }

  get duration(): number { return this.buffer?.duration ?? 0; }
  get loaded(): boolean { return this.buffer !== null; }

  dispose(): void {
    if (this.source) { this.source.stop(); this.source = null; }
    if (this.ctx) void this.ctx.close();
    this.ctx = null;
  }
}