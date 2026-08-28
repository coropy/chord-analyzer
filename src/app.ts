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
import { makeCamera, xToTick, yToPitch, type Camera, type CameraView } from './time/camera';
import { drawGridAndPlayhead, drawPianoKeys, drawMarkersAndRegions } from './renderer/overlay2d';
import { FrameTimeHistogram } from './perf/frameStats';
import { startRafProbe } from './perf/rafDiagnostic';
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
        <span class="brand">Chord Analyzer — Timeline</span>
        <label class="btn-file">♪ MIDI (.mid)
          <input type="file" id="midiFile" accept=".mid,.midi,.smf,audio/midi,audio/x-midi" />
        </label>
        <label class="btn-file">♫ 音声 (WAV/MP3)
          <input type="file" id="audioFile" accept=".wav,.mp3,.ogg,.flac,.m4a,audio/*" />
        </label>
        <span class="sep"></span>
        <span id="loadStatus">MIDI / 音声ファイルを選択してください</span>
        <span class="sep"></span>
        <button id="playBtn" disabled>▶ Play</button>
        <button id="stopBtn" disabled>■ Stop</button>
        <span id="pos">0.000s / 0.000s</span>
        <span class="sep"></span>
        <label>Grid <select id="gridSel">
          <option value="4">1/4</option><option value="8" selected>1/8</option>
          <option value="16">1/16</option><option value="32">1/32</option>
        </select></label>
        <label>Quantize
          <input type="checkbox" id="quantToggle" checked />
          <select id="quantSel">
            <option value="bar/8" selected>1 bar / 8</option>
            <option value="1/4">1/4</option>
            <option value="1/8">1/8</option>
            <option value="1/16">1/16</option>
            <option value="1/32">1/32</option>
          </select>
        </label>
        <span class="sep"></span>
        <button id="undoBtn" disabled>↶ Undo</button>
        <button id="redoBtn" disabled>↷ Redo</button>
        <span class="sep"></span>
        <span class="keyhint">Enter=Marker · Del=Delete · Space=Play · ←→=nudge · Ctrl+Z=Undo</span>
        <span id="raf">rAF —</span>
        <span id="fps">— FPS</span>
        <span id="fr">— ms</span>
        <span id="cpu">cpu —</span>
        <span id="gpu">gpu —</span>
        <span id="vis">vis —</span>
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
          <div id="sbV" class="sb sb-v"><div id="sbVT" class="sb-thumb"></div></div>
          <div id="sbH" class="sb sb-h"><div id="sbHT" class="sb-thumb"></div></div>
        </div>
      </div>
      <div id="trackbar"></div>
    </div>`;

  const $ = <T extends HTMLElement>(id: string): T => root.querySelector('#' + id) as T;
  const midiInput = $<HTMLInputElement>('midiFile');
  const audioInput = $<HTMLInputElement>('audioFile');
  const loadStatus = $<HTMLElement>('loadStatus');
  const playBtn = $<HTMLButtonElement>('playBtn');
  const stopBtn = $<HTMLButtonElement>('stopBtn');
  const undoBtn = $<HTMLButtonElement>('undoBtn');
  const redoBtn = $<HTMLButtonElement>('redoBtn');
  const posEl = $<HTMLElement>('pos');
  const glCanvas = $<HTMLCanvasElement>('gl');
  const overlay = $<HTMLCanvasElement>('overlay');
  const piano = $<HTMLCanvasElement>('piano');
  const trackbar = $<HTMLElement>('trackbar');
  const stage = $<HTMLElement>('stage');
  const fpsEl = $<HTMLElement>('fps');
  const frEl = $<HTMLElement>('fr');
  const cpuEl = $<HTMLElement>('cpu');
  const gpuEl = $<HTMLElement>('gpu');
  const visEl = $<HTMLElement>('vis');
  const rafEl = $<HTMLElement>('raf');
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
  const applySize = (): void => {
    // Measure the actual available stage area; used to be overflowing into the
    // trackbar because the canvas was sized from #wrap minus the as-yet-empty bars.
    const w = Math.max(200, stage.clientWidth - PIANO_W);
    const h = Math.max(200, stage.clientHeight);
    for (const c of [glCanvas, overlay]) {
      c.width = w; c.height = h;
      c.style.width = w + 'px'; c.style.height = h + 'px';
    }
    piano.width = PIANO_W; piano.height = h;
    piano.style.height = h + 'px';
  };
  applySize();
  window.addEventListener('resize', applySize);

  const gl = glCanvas.getContext('webgl2', { antialias: true, alpha: false });
  if (!gl) { playBtn.textContent = 'No WebGL2'; return; }
  gl.clearColor(0.04, 0.04, 0.04, 1);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  const renderer = new WebGL2NoteRenderer(gl);
  const hist = new FrameTimeHistogram(360);
  const probe = startRafProbe();

  let model: NoteModel;
  let tempoMap: TempoMap | null = null;
  let audio: AudioTimelineSource | null = null;
  let camera = makeCamera({ scrollTick: 0, pxPerTick: 0.2, topPitch: MIDI_MAX_PITCH + 1, pxPerPitch: 6 });
  let trackVisible: boolean[] = [];
  let playheadTick = 0;
  let gridDiv = 8;

  // ---- Phase 4 state ----
  const engine = new CommandEngine();
  let regions: ChordRegion[] = [];
  let ppq = 480;

  const renderView = (): RenderView =>
    ({ scrollStartTick: camera.scrollTick, pxPerTick: camera.pxPerTick, topPitch: camera.topPitch, pxPerPitch: camera.pxPerPitch, viewportWidth: glCanvas.width, viewportHeight: glCanvas.height });

  // ---- custom scrollbars ----
  const SCROLLBAR_PX = 16;
  function updateScrollbars(): void {
    const H = glCanvas.height, W = glCanvas.width;
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
      const hSpan = Math.max(1e-6, hHi - hLo), hVisible = glCanvas.width / camera.pxPerTick;
      const hMovable = Math.max(1e-6, hSpan - hVisible);
      const s = dragAnchorCam + delta * (hMovable / Math.max(1, trackW));
      camera = clampScroll({ ...camera, scrollTick: s });
    } else {
      const trackH = sbV.clientHeight - sbVT.clientHeight;
      const vLo = pitchMin - PITCH_MARGIN, vHi = pitchMax + PITCH_MARGIN;
      const vSpan = Math.max(1e-6, vHi - vLo), vVisible = glCanvas.height / camera.pxPerPitch;
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
  function renderTracks(n: number): void {
    trackbar.innerHTML = '';
    for (let i = 0; i < n; i++) {
      const label = document.createElement('label');
      label.className = 'trackRow';
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = true;
      const span = document.createElement('span');
      span.textContent = `T${i} · ${trackCounts[i] ?? 0} notes`;
      cb.addEventListener('change', () => {
        trackVisible[i] = cb.checked;
        renderer.setTrackVisibility([...trackVisible]);
      });
      label.append(cb, span);
      trackbar.appendChild(label);
    }
  }

  // ---- load data from selected MIDI + audio ----
  let audioReady = false;

  /** Build notes + display from a MIDI buffer. Independent of audio. */
  function buildMidi(buffer: ArrayBuffer, label: string): void {
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
      const pxPerPitchFull = glCanvas.height / vSpan;
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
      loadStatus.textContent = `${label} · ${doc.notes.length} notes / ${doc.tracks.length} tracks` + (audioReady ? '' : ' · 音声未選択');
    } catch (err) {
      console.error(err);
      loadStatus.textContent = 'MIDIエラー: ' + (err instanceof Error ? err.message : String(err));
    }
  }

  /** Decode audio and enable playback. Independent of MIDI. */
  async function loadAudio(buffer: ArrayBuffer, label: string): Promise<void> {
    try {
      audio = new WavAudioSource(buffer);
      await audio.load();
      audio.onEnded = () => { playBtn.textContent = '▶ Play'; };
      playBtn.disabled = false;
      stopBtn.disabled = false;
      audioReady = true;
      loadStatus.textContent = (midiStatusLabel ?? 'MIDI未選択') + ` × ${label}`;
    } catch (err) {
      console.error(err);
      loadStatus.textContent = '音声エラー: ' + (err instanceof Error ? err.message : String(err));
    }
  }
  let midiStatusLabel: string | null = null;

  async function fileToBuffer(file: File): Promise<ArrayBuffer> {
    return await file.arrayBuffer();
  }

  midiInput.addEventListener('change', async () => {
    const f = midiInput.files?.[0];
    if (!f) return;
    const buf = await fileToBuffer(f);
    midiStatusLabel = f.name;
    buildMidi(buf, f.name);
  });

  audioInput.addEventListener('change', async () => {
    const f = audioInput.files?.[0];
    if (!f) return;
    const buf = await fileToBuffer(f);
    void loadAudio(buf, f.name);
  });

  // Playback is only enabled once the user picks both files via the buttons.
  // No default files are auto-loaded; the user selects every time.

  // ---- playback ----
  playBtn.addEventListener('click', () => {
    if (!audio?.loaded) return;
    if (audio.playing) { audio.pause(); playBtn.textContent = '▶ Play'; }
    else { audio.play(); playBtn.textContent = 'Ⅱ Pause'; }
  });
  stopBtn.addEventListener('click', () => {
    audio?.stop();
    playheadTick = 0;
    playBtn.textContent = '▶ Play';
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
    const minPx = Math.min(glCanvas.height / Math.max(1, hi - lo), MIN_PX_PER_PITCH);
    const maxPx = MAX_PX_PER_PITCH;
    // zoom caps
    const pxCapped = Math.max(minPx, Math.min(cam.pxPerPitch, maxPx));
    if (pxCapped !== cam.pxPerPitch) cam = { ...cam, pxPerPitch: pxCapped };
    const px = cam.pxPerPitch;
    const heightPx = glCanvas.height;
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
    return Math.max(glCanvas.height / Math.max(1, hi - lo), Math.min(px, MAX_PX_PER_PITCH));
  };
  function zoomVertical(factor: number): void {
    const cy = glCanvas.height / 2;
    const anchorPitch = yToPitch(camera, cy);
    const np = clampedPxPerPitch(camera.pxPerPitch * factor);
    camera = clampPitch({ ...camera, pxPerPitch: np, topPitch: anchorPitch + cy / np });
  }

  // ---- horizontal bounds (first..last note, with margin like vertical) ----
  const clampedPxPerTick = (px: number): number => {
    if (!model) return px;
    const span = model.maxTick - model.minTick;
    const minPx = span > 0 ? Math.min(glCanvas.width / span, 0.05) : 0.05;
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
    const widthTicks = glCanvas.width / Math.max(1e-4, cam.pxPerTick);
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
  function zoomHorizontal(factor: number): void {
    const cx = glCanvas.width / 2;
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

  // ---- render loop ----
  let lastNow = performance.now();
  const oCtx = overlay.getContext('2d')!;
  const pCtx = piano.getContext('2d');

  const frame = (now: number): void => {
    const ms = now - lastNow; lastNow = now;
    hist.push(ms);
    const st = hist.computeStats();
    const rstat = probe.stats();

    if (!model || !tempoMap) { requestAnimationFrame(frame); return; }

    if (audio?.loaded) {
      playheadTick = secondsToTick(tempoMap, audio.getPositionSeconds());
    }
    const view = renderView();
    updateScrollbars();
    renderer.draw(model, view);

    const oview: CameraView = { ...camera, viewportWidth: glCanvas.width, viewportHeight: glCanvas.height };
    const range = { left: oview.scrollTick, right: oview.scrollTick + oview.viewportWidth / oview.pxPerTick };
    const grid = adaptiveGridConfig(gridConfig(4, 2, ppq, gridDiv), oview.pxPerTick);
    const showBarText = barPxSpacing(grid, oview.pxPerTick) >= 90;
    drawGridAndPlayhead(oCtx, oview, grid, range, playheadTick, undefined, showBarText);
    drawMarkersAndRegions(oCtx, oview, engine.markers, regions, engine.selectedId);
    if (pCtx) drawPianoKeys(piano, oview);

    const sec = tempoMap ? tickToSeconds(tempoMap, playheadTick) : 0;
    posEl.textContent = sec.toFixed(3) + 's / ' + (tempoMap?.durationSeconds ?? 0).toFixed(3) + 's';
    fpsEl.textContent = st.avgFps.toFixed(0) + ' FPS';
    frEl.textContent = st.avgMs.toFixed(2) + ' ms';
    cpuEl.textContent = 'cpu ' + renderer.cpuUpdateMs.toFixed(3);
    gpuEl.textContent = 'gpu ' + renderer.drawMs.toFixed(3);
    visEl.textContent = 'vis ' + renderer.lastVisible;
    rafEl.textContent = 'rAF ' + (rstat.observedHz > 0 ? rstat.observedHz.toFixed(0) + 'Hz' : '—') + ' · ' + rstat.notes;

    // debug bar
    const bb = tempoMap ? tickToBarBeat(playheadTick, ppq, 4, 2) : null;
    dbgRaw.textContent = 'raw ' + Math.round(playheadTick);
    const qr = quantizeTick(playheadTick, engine.layout.division, { ppq, numerator: 4 }).quantizedTick;
    dbgQuant.textContent = 'quant ' + qr;
    dbgAudio.textContent = 'audio ' + sec.toFixed(3) + 's';
    dbgBar.textContent = bb ? `bar ${bb.bar} beat ${bb.beat}` : 'bar —';

    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}