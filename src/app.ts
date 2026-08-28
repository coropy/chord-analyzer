/**
 * Phase 4 app: Timeline + Marker + Quantize + Chord Region + Undo/Redo.
 *
 * Extends the Phase 3 WebGL2 piano roll with:
 *  - Enter: add Marker at the current audio-engine position (raw tick).
 *  - Markers as crisp vertical lines; chord regions between markers translucent.
 *  - Quantize ON/OFF + division (1/4,1/8,1/16,1/32, bar/N). rawTick never mutates.
 *  - Undo/Redo (Ctrl+Z / Ctrl+Shift+Z), Backspace/Delete delete, Left/Right nudge.
 *  - Click timeline = seek (markers added via Enter only, so they never collide).
 *  - rAF timing diagnostic: distinguishes monitor-driven vs headless frame clock.
 */
import './style.css';
import { parseMidi } from './midi/MidiParser';
import { buildNoteModel, type NoteModel } from './model/NoteModel';
import { WebGL2NoteRenderer, type RenderView } from './renderer/WebGL2NoteRenderer';
import { WavAudioSource, type AudioTimelineSource } from './audio/AudioSource';
import { buildTempoMap, tickToSeconds, secondsToTick, tickToBarBeat, type TempoMap } from './time/timeline';
import { adaptiveGridConfig, barPxSpacing, gridConfig } from './time/grid';
import { makeCamera, tickToX, xToTick, yToPitch, type Camera, type CameraView } from './time/camera';
import { PresentationClock } from './time/presentationClock';
import { drawGridAndPlayhead, drawPianoKeys, drawMarkersAndRegions } from './renderer/overlay2d';
import { FrameTimeHistogram } from './perf/frameStats';
import { TickStream, type TickStreamSnapshot } from './perf/tickStream';
import { buildRegions, type Marker, type ChordRegion, type QuantizeLayout } from './marker/marker';
import { CommandEngine } from './marker/history';
import { quantizeTick, divisionLabel, type QuantizeDivision } from './marker/quantize';

const MIDI_MIN_PITCH = 34;
const MIDI_MAX_PITCH = 103;
/** Default horizontal zoom: pixel width of one 1/8-note grid division. */
const DEFAULT_1_8_DIV_PX = 36;

export function mount(root: HTMLElement): void {
  root.innerHTML = `
    <div id="wrap">
      <div id="topbar">
        <span class="brand tag">Chord Analyzer — Timeline</span>
        <label class="btn-file fileMidi tag" title="MIDI ファイルを開く (.mid)">
          <svg viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>
          <input type="file" id="midiFile" accept=".mid,.midi,.smf,audio/midi,audio/x-midi" />
        </label>
        <label class="btn-file fileAudio tag" title="音声ファイルを開く (WAV/MP3)">
          <svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/></svg>
          <input type="file" id="audioFile" accept=".wav,.mp3,.ogg,.flac,.m4a,audio/*" />
        </label>
        <span id="pos" class="tag">0.000s / 0.000s</span>
        <span id="barbeat" class="tag">—</span>
        <button id="playBtn" class="iconBtn playBtn tag" disabled title="再生 / 一時停止">
          <svg id="icoPlay" viewBox="0 0 24 24"><path d="M9 5v14l9-7z"/></svg>
          <svg id="icoPause" class="hide" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
        </button>
        <label class="tag gridWrap">Grid <select id="gridSel">
          <option value="4">1/4</option><option value="8" selected>1/8</option>
          <option value="16">1/16</option><option value="32">1/32</option>
        </select></label>
        <label class="tag quantWrap">Quantize
          <input type="checkbox" id="quantToggle" checked />
          <select id="quantSel">
            <option value="bar/8" selected>1 bar / 8</option>
            <option value="1/4">1/4</option>
            <option value="1/8">1/8</option>
            <option value="1/16">1/16</option>
            <option value="1/32">1/32</option>
          </select>
        </label>
        <button id="undoBtn" class="iconBtn tag" disabled title="元に戻す (Ctrl+Z)">
          <svg viewBox="0 0 24 24"><path d="M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z"/></svg>
        </button>
        <button id="redoBtn" class="iconBtn tag" disabled title="やり直す (Ctrl+Shift+Z)">
          <svg viewBox="0 0 24 24"><path d="M18.4 10.6C16.55 8.99 14.15 8 11.5 8c-4.65 0-8.58 3.03-9.96 7.22l2.37.78C5.95 12.86 8.96 11 12.5 11c1.96 0 3.73.72 5.12 1.88L14 16.5h9v-9l-4.6 3.1z"/></svg>
        </button>
        <button id="menuBtn" class="menuBtn tag">☰ メニュー</button>
        <div id="menu">
          <div class="menu-section">
            <div class="menu-title">表示</div>
            <label class="menu-row"><input type="checkbox" id="debugToggle" />デバッグ情報を表示</label>
          </div>
          <div class="menu-section">
            <div class="menu-title">チャンネル / トラック</div>
            <div class="menu-tools">
              <button id="trackAllOn" class="miniBtn" disabled>全ON</button>
              <button id="trackAllOff" class="miniBtn" disabled>全OFF</button>
            </div>
            <div id="trackbar" class="menu-tracks"></div>
          </div>
          <div class="menu-section">
            <div class="menu-title">ショートカット</div>
            <div class="keyhint">Enter=Marker · Del=Delete · Space=Play · ←→=nudge · Ctrl+Z=Undo</div>
          </div>
        </div>
      </div>
      <div id="debugbar">
        <span class="dbg" id="dbgRaw">raw —</span>
        <span class="dbg" id="dbgQuant">quant —</span>
        <span class="dbg" id="dbgAudio">audio —</span>
        <span class="dbg" id="dbgBar">bar/beat —</span>
      </div>
      <div id="stage">
        <div id="pianoWrap"><canvas id="piano"></canvas></div>
        <div id="timelineWrap">
          <canvas id="gl"></canvas><canvas id="overlay"></canvas>
          <div id="fpsOverlay">— FPS</div>
          <div id="sbV" class="sb sb-v"><div id="sbVT" class="sb-thumb"></div></div>
          <div id="sbH" class="sb sb-h"><div id="sbHT" class="sb-thumb"></div></div>
        </div>
      </div>
    </div>`;

  const $ = <T extends HTMLElement>(id: string): T => root.querySelector('#' + id) as T;
  const midiInput = $<HTMLInputElement>('midiFile');
  const audioInput = $<HTMLInputElement>('audioFile');
  const playBtn = $<HTMLButtonElement>('playBtn');
  const icoPlay = $<HTMLElement>('icoPlay');
  const icoPause = $<HTMLElement>('icoPause');
  const undoBtn = $<HTMLButtonElement>('undoBtn');
  const redoBtn = $<HTMLButtonElement>('redoBtn');
  const posEl = $<HTMLElement>('pos');
  const barbeatEl = $<HTMLElement>('barbeat');
  const glCanvas = $<HTMLCanvasElement>('gl');
  const overlay = $<HTMLCanvasElement>('overlay');
  const piano = $<HTMLCanvasElement>('piano');
  const trackbar = $<HTMLElement>('trackbar');
  const debugbar = $<HTMLElement>('debugbar');
  const menu = $<HTMLElement>('menu');
  const menuBtn = $<HTMLButtonElement>('menuBtn');
  const debugToggle = $<HTMLInputElement>('debugToggle');
  const trackAllOn = $<HTMLButtonElement>('trackAllOn');
  const trackAllOff = $<HTMLButtonElement>('trackAllOff');
  const stage = $<HTMLElement>('stage');
  const fpsOverlay = $<HTMLElement>('fpsOverlay');
  const dbgRaw = $<HTMLElement>('dbgRaw');
  const dbgQuant = $<HTMLElement>('dbgQuant');
  const dbgAudio = $<HTMLElement>('dbgAudio');
  const dbgBar = $<HTMLElement>('dbgBar');
  const quantToggle = $<HTMLInputElement>('quantToggle');
  const quantSel = $<HTMLSelectElement>('quantSel');
  const gridSel = $<HTMLSelectElement>('gridSel');
  const sbV = $<HTMLElement>('sbV');
  const sbH = $<HTMLElement>('sbH');
  const sbVT = $<HTMLElement>('sbVT');
  const sbHT = $<HTMLElement>('sbHT');
  const timelineWrap = $<HTMLElement>('timelineWrap');

  const PIANO_W = 52;
  // Logical CSS-pixel viewport (all camera math / hit-testing / scrollbars work
  // in this space). The canvas backing stores are sized to the monitor's
  // devicePixelRatio so rendering is natively sharp instead of a low-res
  // upscale that reads as blur / stepped edges / doubled strokes on HiDPI and
  // high-refresh (120Hz+) displays.
  const dpr = (): number => window.devicePixelRatio || 1;
  let cssW = 0, cssH = 0;
  const applySize = (): void => {
    // Measure the actual available stage area; used to be overflowing into the
    // trackbar because the canvas was sized from #wrap minus the as-yet-empty bars.
    const w = Math.max(200, stage.clientWidth - PIANO_W);
    const h = Math.max(200, stage.clientHeight);
    cssW = w; cssH = h;
    const d = dpr();
    for (const c of [glCanvas, overlay]) {
      c.width = Math.round(w * d); c.height = Math.round(h * d);
      c.style.width = w + 'px'; c.style.height = h + 'px';
    }
    piano.width = Math.round(PIANO_W * d); piano.height = Math.round(h * d);
    piano.style.width = PIANO_W + 'px'; piano.style.height = h + 'px';
  };
  applySize();
  window.addEventListener('resize', applySize);

  const gl = glCanvas.getContext('webgl2', { antialias: true, alpha: false });
  if (!gl) { console.error('WebGL2 not supported'); return; }
  gl.clearColor(0.04, 0.04, 0.04, 1);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  const renderer = new WebGL2NoteRenderer(gl);
  const hist = new FrameTimeHistogram(360);
  const stream = new TickStream(480);

  let model: NoteModel;
  let tempoMap: TempoMap | null = null;
  let audio: AudioTimelineSource | null = null;
  let camera = makeCamera({ scrollTick: 0, pxPerTick: 0.2, topPitch: MIDI_MAX_PITCH + 1, pxPerPitch: 6 });
  let trackVisible: boolean[] = [];
  /** CANONICAL playhead from the audio engine (tick). */
  let playheadTick = 0;
  /** Continuous VISUAL playhead tick (presentation clock extrapolation). */
  let visualTick = 0;
  const present = new PresentationClock();
  let gridDiv = 8;

  // ---- Phase 4 state ----
  const engine = new CommandEngine();
  let regions: ChordRegion[] = [];
  let ppq = 480;

  const rendererView = (): RenderView =>
    ({ scrollStartTick: camera.scrollTick, pxPerTick: camera.pxPerTick, topPitch: camera.topPitch, pxPerPitch: camera.pxPerPitch, viewportWidth: cssW, viewportHeight: cssH, dpr: dpr() });

  // ---- custom scrollbars ----
  const SCROLLBAR_PX = 16;
  function updateScrollbars(): void {
    const H = cssH, W = cssW;
    if (!model) { sbH.classList.remove('visible'); sbV.classList.remove('visible'); return; }
    // horizontal: raw scroll range in ticks
    const mT = tickMargin();
    const hLo = model.minTick - mT;
    const hHi = model.maxTick + mT;
    const hSpan = Math.max(1e-6, hHi - hLo);
    const hVisible = W / camera.pxPerTick;
    const hMovable = hSpan - hVisible;
    const hCan = hMovable > 1e-3 && hVisible < hSpan;
    const hTrack = sbH.clientWidth;
    const hThumb = hCan ? Math.max(SCROLLBAR_PX, hTrack * (hVisible / hSpan)) : 0;
    const hFrac = hCan ? (camera.scrollTick - hLo) / hMovable : 0;
    sbHT.style.left = (hFrac * Math.max(0, hTrack - hThumb)) + 'px';
    sbHT.style.width = hThumb + 'px';
    sbH.classList.toggle('visible', hCan);
    // vertical: pitch scroll range
    const vLo = pitchMin - PITCH_MARGIN;
    const vHi = pitchMax + PITCH_MARGIN;
    const vSpan = Math.max(1e-6, vHi - vLo);
    const vVisible = H / camera.pxPerPitch;
    const vMovable = vSpan - vVisible;
    const vCan = vMovable > 1e-3 && vVisible < vSpan;
    const vH = sbV ? sbV.clientHeight : 0;
    const vThumb = vCan ? Math.max(SCROLLBAR_PX, vH * (vVisible / vSpan)) : 0;
// topPitch = vHi (highest) -> thumb at top; topPitch = vMinTop (lowest) -> thumb at bottom.
    const vFrac = vCan ? (vHi - camera.topPitch) / vMovable : 0;
    sbVT.style.top = (vFrac * Math.max(0, vH - vThumb)) + 'px';
    sbVT.style.height = vThumb + 'px';
    sbV.classList.toggle('visible', vCan);
  }
  let dragVm: 'h' | 'v' | null = null;
  let dragStartClient = 0;
  let dragAnchorCam = 0;
  function beginDrag(axis: 'h' | 'v', e: PointerEvent): void {
    // Anchor at thumb position: store thumb client pos and current camera value
    dragVm = axis;
    if (axis === 'h') {
      dragStartClient = sbHT.getBoundingClientRect().left;
      dragAnchorCam = camera.scrollTick;
    } else {
      dragStartClient = sbVT.getBoundingClientRect().top;
      dragAnchorCam = camera.topPitch;
    }
    timelineWrap.classList.add('dragging');
    timelineWrap.setPointerCapture(e.pointerId);
  }
  function beginFromOffsetOrJump(delta: number, axis: 'h' | 'v'): void {
    if (axis === 'h') {
      const trackW = sbH.clientWidth - sbHT.clientWidth;
      const mT = tickMargin(), hLo = model.minTick - mT, hHi = model.maxTick + mT;
      const hSpan = Math.max(1e-6, hHi - hLo), hVisible = cssW / camera.pxPerTick;
      const hMovable = Math.max(1e-6, hSpan - hVisible);
      const s = dragAnchorCam + delta * (hMovable / Math.max(1, trackW));
      camera = clampScroll({ ...camera, scrollTick: s });
    } else {
      const trackH = sbV.clientHeight - sbVT.clientHeight;
      const vLo = pitchMin - PITCH_MARGIN, vHi = pitchMax + PITCH_MARGIN;
      const vSpan = Math.max(1e-6, vHi - vLo), vVisible = cssH / camera.pxPerPitch;
      const vMovable = Math.max(1e-6, vSpan - vVisible);
      const top = dragAnchorCam - delta * (vMovable / Math.max(1, trackH));
      camera = clampPitch({ ...camera, topPitch: top });
    }
  }
  // Drag directly on the thumb (which is pointer-events:auto)
  sbHT.addEventListener('pointerdown', (e) => { if (!sbH.classList.contains('visible')) return; e.stopPropagation(); beginDrag('h', e); });
  sbVT.addEventListener('pointerdown', (e) => { if (!sbV.classList.contains('visible')) return; e.stopPropagation(); beginDrag('v', e); });
  window.addEventListener('pointermove', (e) => { if (dragVm) beginFromOffsetOrJump(
    dragVm === 'h' ? e.clientX - dragStartClient : e.clientY - dragStartClient, dragVm); });
  window.addEventListener('pointerup', () => {
    if (!dragVm) return;
    dragVm = null;
    timelineWrap.classList.remove('dragging');
  });
  // Show bars while the mouse is over the timeline area, fade when idle
  let hideBarTimer: ReturnType<typeof setTimeout> | null = null;
  const revealBars = (): void => {
    timelineWrap.classList.add('bars-hover');
    if (hideBarTimer) clearTimeout(hideBarTimer);
    hideBarTimer = setTimeout(() => timelineWrap.classList.remove('bars-hover'), 900);
  };
  timelineWrap.addEventListener('pointermove', revealBars);
  timelineWrap.addEventListener('pointerenter', revealBars);

  // ---- track controls ----
  let trackCounts: number[] = [];
  function applyTrackVisibility(): void {
    renderer.setTrackVisibility([...trackVisible]);
  }
  function renderTracks(n: number): void {
    trackbar.innerHTML = '';
    for (let i = 0; i < n; i++) {
      const label = document.createElement('label');
      label.className = 'trackRow';
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = trackVisible[i] ?? true;
      const span = document.createElement('span');
      span.textContent = `T${i} · ${trackCounts[i] ?? 0} notes`;
      cb.addEventListener('change', () => {
        trackVisible[i] = cb.checked;
        applyTrackVisibility();
      });
      label.append(cb, span);
      trackbar.appendChild(label);
    }
    trackAllOn.disabled = n === 0;
    trackAllOff.disabled = n === 0;
  }
  trackAllOn.addEventListener('click', () => {
    trackVisible = trackVisible.map(() => true);
    renderTracks(trackVisible.length);
    applyTrackVisibility();
  });
  trackAllOff.addEventListener('click', () => {
    trackVisible = trackVisible.map(() => false);
    renderTracks(trackVisible.length);
    applyTrackVisibility();
  });

  // ---- menu ----
  // Debug bar is hidden by default; the checkbox turns it on.
  debugbar.classList.add('hidden');
  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.classList.toggle('open');
  });
  debugToggle.addEventListener('change', () => {
    debugbar.classList.toggle('hidden', !debugToggle.checked);
    applySize();
  });
  document.addEventListener('click', (e) => {
    if (menu.classList.contains('open') && !menu.contains(e.target as Node)) {
      menu.classList.remove('open');
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menu.classList.contains('open')) menu.classList.remove('open');
  });

  // ---- load data from selected MIDI + audio ----

  /** Build notes + display from a MIDI buffer. Independent of audio. */
  function buildMidi(buffer: ArrayBuffer): void {
    try {
      const doc = parseMidi(new Uint8Array(buffer));
      tempoMap = buildTempoMap(doc);
      model = buildNoteModel(doc.notes);
      // clamp display to the MIDI's actual high/low range
      pitchMin = Infinity; pitchMax = -Infinity;
      for (let i = 0; i < model.count; i++) {
        const p = model.pitches[i];
        if (p < pitchMin) pitchMin = p;
        if (p > pitchMax) pitchMax = p;
      }
      if (!isFinite(pitchMin)) { pitchMin = MIDI_MIN_PITCH; pitchMax = MIDI_MAX_PITCH; }
      ppq = doc.ppq;
      trackVisible = Array.from({ length: doc.tracks.length }, () => true);
      trackCounts = doc.tracks.map((t) => t.noteCount);
      renderer.uploadNotes(model);
      renderer.setTrackVisibility(trackVisible);
      renderTracks(doc.tracks.length);
      applySize();
      // Vertical: exact fit so the highest note sits on the top edge and the
      // lowest on the bottom edge. span>0 implies pxPerPitch>0 -> no scrollbar.
      const vSpan = Math.max(1e-6, pitchMax - pitchMin);
      const pxPerPitchFull = cssH / vSpan;
      // Horizontal: 1/8-note grid division has a fixed, readable pixel width.
      // 1/8 division = one eighth-note = ppq/2 ticks in 4/4.
      const ticksPerDiv = Math.max(1, Math.round(ppq * 4 / 8));
      const pxPerTickDiv = DEFAULT_1_8_DIV_PX / ticksPerDiv;
      camera = makeCamera({
        scrollTick: model.minTick,
        pxPerTick: pxPerTickDiv,
        topPitch: pitchMax,
        pxPerPitch: pxPerPitchFull,
      });
      camera = clampScroll(clampPitch(camera));
    } catch (err) {
      console.error(err);
    }
  }

  /** Decode audio and enable playback. Independent of MIDI. */
  async function loadAudio(buffer: ArrayBuffer): Promise<void> {
    try {
      audio = new WavAudioSource(buffer);
      await audio.load();
      audio.onEnded = () => setPaused();
      playBtn.disabled = false;
    } catch (err) {
      console.error(err);
    }
  }
  async function fileToBuffer(file: File): Promise<ArrayBuffer> {
    return await file.arrayBuffer();
  }

  midiInput.addEventListener('change', async () => {
    const f = midiInput.files?.[0];
    if (!f) return;
    const buf = await fileToBuffer(f);
    buildMidi(buf);
  });

  audioInput.addEventListener('change', async () => {
    const f = audioInput.files?.[0];
    if (!f) return;
    const buf = await fileToBuffer(f);
    void loadAudio(buf);
  });

  // Playback is only enabled once the user picks both files via the buttons.
  // No default files are auto-loaded; the user selects every time.

  // ---- playback ----
  function setPaused(): void {
    icoPlay.classList.remove('hide');
    icoPause.classList.add('hide');
    playBtn.title = '再生';
  }
  function setPlaying(): void {
    icoPlay.classList.add('hide');
    icoPause.classList.remove('hide');
    playBtn.title = '一時停止';
  }
  playBtn.addEventListener('click', () => {
    if (!audio?.loaded) return;
    if (audio.playing) { audio.pause(); setPaused(); }
    else { audio.play(); setPlaying(); }
  });
  // Click again while playing = stop (back to start).
  playBtn.addEventListener('dblclick', () => {
    if (!audio?.loaded) return;
    audio.stop();
    playheadTick = 0;
    setPaused();
  });

  function seekToTick(tick: number): void {
    if (!audio?.loaded || !tempoMap) return;
    audio.seek(tickToSeconds(tempoMap, tick));
    playheadTick = tick;
  }

  // ---- marker helpers ----
  function refreshRegions(): void { regions = buildRegions(engine.markers); }
  function selectedMarker(): Marker | undefined {
    if (engine.selectedId == null) return undefined;
    return engine.markers.find((m) => m.id === engine.selectedId!);
  }
  function updateButtons(): void {
    undoBtn.disabled = !engine.canUndo;
    redoBtn.disabled = !engine.canRedo;
  }

  function addMarkerAtCurrent(): void {
    if (!audio?.loaded || !tempoMap) return;
    const sec = audio.getPositionSeconds();
    const rawTick = secondsToTick(tempoMap, sec);
    engine.addMarker(rawTick);
    refreshRegions();
    updateButtons();
  }
  function deleteSelected(): void {
    if (engine.selectedId == null) return;
    engine.deleteMarker(engine.selectedId);
    refreshRegions();
    updateButtons();
  }
  const NUDGE_TICKS = 24;
  function nudgeSelected(dir: number): void {
    if (engine.selectedId == null) return;
    const m = selectedMarker();
    if (!m) return;
    engine.moveMarker(m.id, m.rawTick + dir * NUDGE_TICKS);
    refreshRegions();
    updateButtons();
  }
  function doUndo(): void { if (engine.undo()) { refreshRegions(); updateButtons(); } }
  function doRedo(): void { if (engine.redo()) { refreshRegions(); updateButtons(); } }

  // ---- quantize UI ----
  const quantLayout: QuantizeLayout = { enabled: true, division: { barDivisions: 8 } };
  function currentDivision(): QuantizeDivision {
    const v = quantSel.value;
    if (v === 'bar/8') return { barDivisions: 8 };
    if (v === '1/4') return '1/4';
    if (v === '1/8') return '1/8';
    if (v === '1/16') return '1/16';
    return '1/32';
  }
  function applyQuantize(): void {
    // pass the desired layout to the engine; engine compares against its current
    // layout and records a changeQuantize command only if it differs.
    engine.setLayout({ enabled: quantLayout.enabled, division: quantLayout.division });
    refreshRegions();
    updateButtons();
  }
  quantToggle.addEventListener('change', () => {
    quantLayout.enabled = quantToggle.checked;
    applyQuantize();
  });
  quantSel.addEventListener('change', () => {
    quantLayout.division = currentDivision();
    applyQuantize();
  });

  // ---- interaction: click to seek ----
  let pan = { x: 0, y: 0, down: false, moved: false };
  /** Vertical scroll bounds. Bottom edge is lowest pitch. 0 = highest note at top edge. */
  const PITCH_MARGIN = 0;
  let pitchMin = MIDI_MIN_PITCH;
  let pitchMax = MIDI_MAX_PITCH;
  const MIN_PX_PER_PITCH = 4;      // full-range fit (fully shrink-stopped)
  const MAX_PX_PER_PITCH = 90;     // zoom-in limit (one semitone band becomes large)
  function clampPitch(cam: Camera): Camera {
    if (!model) return cam;
    const topVisible = cam.topPitch;
    // full band [min-…, max+…] that must stay reachable.
    const lo = pitchMin - PITCH_MARGIN;
    const hi = pitchMax + PITCH_MARGIN;
    const minPx = Math.min(cssH / Math.max(1, hi - lo), MIN_PX_PER_PITCH);
    const maxPx = MAX_PX_PER_PITCH;
    // zoom caps
    const pxCapped = Math.max(minPx, Math.min(cam.pxPerPitch, maxPx));
    if (pxCapped !== cam.pxPerPitch) cam = { ...cam, pxPerPitch: pxCapped };
    const px = cam.pxPerPitch;
    const heightPx = cssH;
    // Clamp scroll so the visible pitch window never leaves [lo, hi].
    // topPitch maps to y=0; bottom visible pitch = topPitch - heightPx/px.
    // Filter: lo <= bottomVisible AND topVisible <= hi
    const minTop = lo + heightPx / px;
    const maxTop = hi;
    const top = Math.max(minTop, Math.min(topVisible, maxTop));
    return { ...cam, topPitch: top };
  }
  const clampedPxPerPitch = (px: number): number => {
    if (!model) return Math.max(px, MIN_PX_PER_PITCH);
    const lo = pitchMin - PITCH_MARGIN, hi = pitchMax + PITCH_MARGIN;
    return Math.max(cssH / Math.max(1, hi - lo), Math.min(px, MAX_PX_PER_PITCH));
  };
  function zoomVertical(factor: number): void {
    const cy = cssH / 2;
    const anchorPitch = yToPitch(camera, cy);
    const np = clampedPxPerPitch(camera.pxPerPitch * factor);
    camera = clampPitch({ ...camera, pxPerPitch: np, topPitch: anchorPitch + cy / np });
  }

  // ---- horizontal bounds (first..last note, with margin like vertical) ----
  const clampedPxPerTick = (px: number): number => {
    if (!model) return px;
    const span = model.maxTick - model.minTick;
    const minPx = span > 0 ? Math.min(cssW / span, 0.05) : 0.05;
    return Math.max(minPx, Math.min(px, 2));
  };
  function tickMargin(): number {
    if (!model) return 0;
    return Math.max(0, Math.round((model.maxTick - model.minTick) / 50));
  }
  function clampScroll(cam: Camera): Camera {
    if (!model) return cam;
    const margin = tickMargin();
    const lo = model.minTick - margin;
    const hi = model.maxTick + margin;
    const widthTicks = cssW / Math.max(1e-4, cam.pxPerTick);
    let s = cam.scrollTick;
    const minS = lo;
    const maxS = hi - widthTicks;
    if (widthTicks >= (hi - lo)) {
      s = lo - (widthTicks - (hi - lo)) / 2;
    } else {
      s = Math.max(minS, Math.min(s, maxS));
    }
    return { ...cam, scrollTick: s };
  }
  /**
   * Karaoke follow. Edge-pinning is the priority: when the playhead-centred
   * view would let space outside the piece enter, pin the left/right edge to
   * the viewport edge instead. scrollTick = clamp(tick - W/2, lo, hi - W).
   */
  function followScroll(cam: Camera, tick: number): Camera {
    if (!model) return cam;
    const m = tickMargin();
    const lo = model.minTick - m;
    const hi = model.maxTick + m;
    const W = cssW / Math.max(1e-4, cam.pxPerTick);
    if (W >= (hi - lo)) {
      // Whole piece + margin fits: keep it fully inside, centred.
      return { ...cam, scrollTick: lo - (W - (hi - lo)) / 2 };
    }
    // Edge-pinning via hard clamp: outer space never enters the view.
    const s = Math.max(lo, Math.min(tick - W / 2, hi - W));
    return { ...cam, scrollTick: s };
  }
  function zoomHorizontal(factor: number): void {
    const cx = cssW / 2;
    const anchorTick = xToTick(camera, cx);
    const npx = clampedPxPerTick(camera.pxPerTick * factor);
    const after = { ...camera, pxPerTick: npx, scrollTick: anchorTick - cx / npx };
    camera = clampScroll(after);
  }
  glCanvas.addEventListener('pointerdown', (e) => {
    pan.x = e.clientX; pan.y = e.clientY; pan.down = true; pan.moved = false;
    glCanvas.setPointerCapture(e.pointerId);
  });
  glCanvas.addEventListener('pointermove', (e) => {
    if (!pan.down) return;
    const dx = e.clientX - pan.x, dy = e.clientY - pan.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) pan.moved = true;
    if (pan.moved) {
      let c: Camera = { ...camera, scrollTick: camera.scrollTick - dx / camera.pxPerTick, topPitch: camera.topPitch + dy / camera.pxPerPitch };
      c = clampScroll(c);
      camera = clampPitch(c);
      pan.x = e.clientX; pan.y = e.clientY;
    }
  });
  glCanvas.addEventListener('pointerup', (e) => {
    if (!pan.down) return;
    pan.down = false;
    if (!pan.moved) {
      const rect = glCanvas.getBoundingClientRect();
      const tick = Math.round(xToTick(camera, e.clientX - rect.left));
      seekToTick(tick);
    }
  });
  glCanvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = glCanvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    if (e.shiftKey) {
      const anchorPitch = yToPitch(camera, my);
      const np = clampedPxPerPitch(camera.pxPerPitch * f);
      camera = clampPitch({ ...camera, pxPerPitch: np, topPitch: anchorPitch + my / np });
    } else {
      const anchorTick = xToTick(camera, mx);
      const npx = clampedPxPerTick(camera.pxPerTick * f);
      const after = { ...camera, pxPerTick: npx, scrollTick: anchorTick - mx / npx };
      camera = clampScroll(after);
    }
  });
  gridSel.addEventListener('change', (e) => {
    gridDiv = Number((e.target as HTMLSelectElement).value);
  });

  // ---- keyboard ----
  window.addEventListener('keydown', (e) => {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (e.ctrlKey && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); }
    else if (e.key === 'Enter') { e.preventDefault(); addMarkerAtCurrent(); }
    else if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); deleteSelected(); }
    else if (e.key === ' ') { e.preventDefault(); playBtn.click(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); nudgeSelected(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); nudgeSelected(1); }
    else if (e.key === '=' || e.key === '+') { e.preventDefault(); zoomVertical(1.25); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomVertical(1 / 1.25); }
    else if (e.key === ']' || e.key === '}') { e.preventDefault(); zoomHorizontal(1.25); }
    else if (e.key === '[' || e.key === '{') { e.preventDefault(); zoomHorizontal(1 / 1.25); }
  });

  // ---- monitor (E2E probe) ----
  (window as unknown as Record<string, unknown>).__appMonitor = () => ({
    markers: engine.markers.map((m) => ({ id: m.id, raw: m.rawTick, q: m.quantizedTick, enabled: m.quantizeEnabled })),
    regions: regions.length,
    quantize: { enabled: engine.layout.enabled, division: divisionLabel(engine.layout.division) },
    selected: engine.selectedId,
    undoDepth: engine.undoDepth,
    canUndo: engine.canUndo,
    canRedo: engine.canRedo,
    playing: audio?.playing ?? false,
    pos: audio?.getPositionSeconds() ?? 0,
  });

  (window as unknown as Record<string, unknown>).__appCamera = () => ({
    scrollTick: camera.scrollTick,
    pxPerTick: camera.pxPerTick,
    topPitch: camera.topPitch,
    pxPerPitch: camera.pxPerPitch,
  });

  (window as unknown as Record<string, unknown>).__audioProbe = () => ({
    ctxNow: audio && audio instanceof WavAudioSource ? audio.ctxNow() : 0,
    pos: audio?.getPositionSeconds() ?? 0,
    raw: audio instanceof WavAudioSource ? audio.rawClockPositionSeconds() : 0,
    outLat: audio instanceof WavAudioSource ? audio.outputLatencySeconds() : 0,
  });

  // ---- judder telemetry (120Hz real-display diagnosis) ----
  (window as unknown as Record<string, unknown>).__tickDiag = () => ({ snapshot: stream.stats(), size: stream.size });

  // nominal display refresh in Hz (VSR-aware: starts at 60, upconverts only when
  // rAF consistently runs faster). Separated so the UI counter never aliases.
  let displayHz = 60;
  {
    let rafSum = 0, rafN = 0, rafMin = 1e9;
    let lastT = performance.now();
    const probeLoop = (now: number): void => {
      const d = now - lastT; lastT = now;
      if (d > 0 && d < 100) {
        rafSum += d; rafN++; if (d < rafMin) rafMin = d;
        if (rafN >= 60) {
          const avg = rafSum / rafN;
          const est = 1000 / avg;
          // 120-class when sustained cadence is ~8.3ms; stay at 60 otherwise
          let r = 60;
          if (est >= 90) r = 120;
          if (rafMin <= 9.5) r = 120;
          displayHz = r;
          rafSum = 0; rafN = 0; rafMin = 1e9;
        }
      }
      requestAnimationFrame(probeLoop);
    };
    requestAnimationFrame(probeLoop);
  }

  // ---- render loop ----
  let lastNow = performance.now();
  const oCtx = overlay.getContext('2d')!;
  const pCtx = piano.getContext('2d');

  const frame = (now: number): void => {
    const ms = now - lastNow; lastNow = now;
    hist.push(ms);
    const st = hist.computeStats();

    if (!model || !tempoMap) { requestAnimationFrame(frame); return; }

    if (audio?.loaded) {
      // Canonical audio position stays the engine clock. The presentation
      // clock extrapolates between the two latest distinct samples so the
      // visual playhead glides at 120fps instead of stepping in audio-quantum
      // chunks (which made the whole picture judder every 3rd-4th frame).
      const rawPos = audio.getPositionSeconds();
      playheadTick = secondsToTick(tempoMap, rawPos);
      if (audio.playing) {
        visualTick = secondsToTick(tempoMap, present.update(rawPos, now));
      } else {
        visualTick = playheadTick;
        present.reset();
      }
      stream.presentInt = present.internals();
    }
    // Karaoke follow: drive the camera only during active playback so the
    // view doesn't fight the user's manual pan/zoom when idle or stopped.
    if (audio?.playing) camera = followScroll(camera, visualTick);
    updateScrollbars();
    const view = rendererView();
    renderer.draw(model, view);
    if (audio?.loaded) {
      // Push one frame of telemetry (off hot path: ring push only).
      const aSrc = audio as WavAudioSource;
      stream.push({
        rafMs: now,
        audioCtxSec: aSrc.ctxNow(),
        audioSec: audio.getPositionSeconds(),
        playheadTick: visualTick,
        scrollTick: camera.scrollTick,
        gridX: 0,
        noteX: 0,
        playheadX: tickToX(camera, visualTick),
        fpsBrowser: st.avgFps,
        displayHz,
        dpr: dpr(),
        backingW: glCanvas.width,
        backingH: glCanvas.height,
        gpuMs: renderer.drawMs,
        cpuMs: renderer.cpuUpdateMs,
        uploadBytes: renderer.lastUploadBytes,
        visible: renderer.lastVisible,
        pxPerTick: camera.pxPerTick,
      });
    }

    // Scale the 2D overlay context so the CSS-pixel camera math maps 1:1 onto
    // the (DPR-sized) backing store — matches the WebGL note layer exactly.
    const d = dpr();
    oCtx.setTransform(d, 0, 0, d, 0, 0);
    const oview: CameraView = { ...camera, viewportWidth: cssW, viewportHeight: cssH, dpr: d };
    const range = { left: oview.scrollTick, right: oview.scrollTick + oview.viewportWidth / oview.pxPerTick };
    const grid = adaptiveGridConfig(gridConfig(4, 2, ppq, gridDiv), oview.pxPerTick);
    const showBarText = barPxSpacing(grid, oview.pxPerTick) >= 90;
    // During playback the playhead/notes move every frame; snap the overlay to
    // exact positions (no sub-pixel rounding) so it tracks the GPU notes in
    // lockstep instead of flickering between half-pixel offsets.
    const moving = audio?.playing === true;
    drawGridAndPlayhead(oCtx, oview, grid, range, visualTick, undefined, showBarText, moving);
    drawMarkersAndRegions(oCtx, oview, engine.markers, regions, engine.selectedId, undefined, moving);
    if (pCtx) drawPianoKeys(piano, oview);

    const sec = tempoMap ? tickToSeconds(tempoMap, playheadTick) : 0;
    const bb = tempoMap ? tickToBarBeat(playheadTick, ppq, 4, 2) : null;
    posEl.textContent = sec.toFixed(3) + 's / ' + (tempoMap?.durationSeconds ?? 0).toFixed(3) + 's';
    barbeatEl.textContent = bb ? `${bb.bar}:${bb.beat}` : '—';
    fpsOverlay.textContent = st.avgFps.toFixed(0) + ' FPS';

    // ---- real-time judder diagnostics on the WQXGA@120Hz panel ----
    const snap = stream.stats();
    const dFmt = (d: TickStreamSnapshot['deltas']['audioTick']): string =>
      `a${d.avg.toFixed(2)}/m${d.max.toFixed(2)}/p1${d.p1.toFixed(2)}/p99${d.p99.toFixed(2)} j${d.maxJump.toFixed(2)}`;
    const mono = (v: boolean): string => (v ? '✓' : '✗');
    const dt = snap.deltas;
    const qr = quantizeTick(playheadTick, engine.layout.division, { ppq, numerator: 4 }).quantizedTick;
    dbgRaw.textContent = 'raw ' + playheadTick.toFixed(1);
    dbgQuant.textContent = 'quant ' + qr;
    dbgAudio.textContent =
      `dH ${snap.displayHz}Hz raf ${snap.rafHz.toFixed(0)}Hz(${snap.rafMedianMs.toFixed(2)}ms)` +
      ` ctx ${snap.audioCtxSec.toFixed(3)}s pos ${snap.audioSec.toFixed(3)}s` +
      ` · vis ${visualTick.toFixed(1)} (${mono(snap.monotonic.playhead)}) scrollTick ${snap.scrollTick.toFixed(1)}(${mono(snap.monotonic.scroll)})` +
      ` px @${snap.playheadX.toFixed(1)}(${mono(snap.monotonic.playheadX)})` +
      ` · dpr ${snap.dpr} bk ${snap.backing.w}x${snap.backing.h}` +
      ` · gpu ${snap.gpuMs.toFixed(3)}ms cpu ${snap.cpuMs.toFixed(3)}ms up ${snap.uploadBytes}B`;
    dbgBar.textContent =
      `Δtick avg/max/p1/p99 ${dFmt(dt.audioTick)}` +
      ` · Δscroll ${dFmt(dt.scrollTick)}` +
      ` · Δraf ${dFmt(dt.raf)}` +
      ` · ΔX mean ${snap.motion.dx.avg.toFixed(3)} std ${snap.motion.dx.std.toFixed(3)} min ${snap.motion.dx.min.toFixed(3)} max ${snap.motion.dx.max.toFixed(3)} p99 ${snap.motion.dx.p99.toFixed(3)}` +
      ` · theo ${snap.motion.theoryDXPerFrame.toFixed(3)}px @${snap.motion.pxPerTick.toFixed(3)}ppt` +
      ` · pc v ${snap.present.velocity.toFixed(4)}±${snap.present.calibSpanMs.toFixed(0)}ms${snap.present.calibN} err ${snap.present.err.toFixed(4)}` +
      (bb ? ` · ${bb.bar}/${bb.beat}` : '') +
      (snap.frameDropHint ? ' · ⚠ frame-drop' : '') +
      (snap.notes.length ? ' · ' + snap.notes.join(' · ') : '');

    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}