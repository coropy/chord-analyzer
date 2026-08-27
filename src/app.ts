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
import { gridConfig } from './time/grid';
import { makeCamera, xToTick, yToPitch, type Camera, type CameraView } from './time/camera';
import { drawGridAndPlayhead, drawPianoKeys, drawMarkersAndRegions } from './renderer/overlay2d';
import { FrameTimeHistogram } from './perf/frameStats';
import { startRafProbe } from './perf/rafDiagnostic';
import { buildRegions, type Marker, type ChordRegion, type QuantizeLayout } from './marker/marker';
import { CommandEngine } from './marker/history';
import { quantizeTick, divisionLabel, type QuantizeDivision } from './marker/quantize';

const MIDI_MIN_PITCH = 34;
const MIDI_MAX_PITCH = 103;

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
        <div id="timelineWrap"><canvas id="gl"></canvas><canvas id="overlay"></canvas></div>
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
  const topbar = $<HTMLElement>('topbar');
  const debugbar = $<HTMLElement>('debugbar');
  const trackbar = $<HTMLElement>('trackbar');
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

  const PIANO_W = 52;
  const applySize = (): void => {
    const bg = $<HTMLElement>('wrap');
    const w = Math.max(200, bg.clientWidth - PIANO_W);
    const h = Math.max(240, bg.clientHeight - topbar.offsetHeight - debugbar.offsetHeight - trackbar.offsetHeight);
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
  gl.clearColor(0.08, 0.085, 0.11, 1);
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

      const fitP = glCanvas.height / ((pitchMax - pitchMin) + 2);
      camera = makeCamera({
        scrollTick: model.minTick,
        pxPerTick: glCanvas.width / Math.max(1, model.maxTick - model.minTick),
        topPitch: pitchMax + 1,
        pxPerPitch: fitP,
      });
      camera = clampPitch(camera);
      renderTracks(doc.tracks.length);
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

  // Auto-load the bundled default MIDI so notes appear immediately on launch.
  midiStatusLabel = 'default (./data/nakanori_mt3.mid)';
  fetch('./data/nakanori_mt3.mid')
    .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error('default midi: HTTP ' + r.status))))
    .then((b) => buildMidi(b, 'default'))
    .catch((e) => { loadStatus.textContent = 'MIDI要選択: ' + (e?.message ?? e); });

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
  /** Vertical scroll bounds. Bottom edge is lowest pitch. */
  const PITCH_MARGIN = 2;
  let pitchMin = MIDI_MIN_PITCH;
  let pitchMax = MIDI_MAX_PITCH;

  /** Clamp camera so the visible pitch range never leaves [pitchMin-1, pitchMax+1]. */
  function clampPitch(cam: Camera): Camera {
    if (!model) return cam;
    // visible bottom pitch = topPitch - height/pxPerPitch
    const topVisible = cam.topPitch;
    const pxPer = Math.max(cam.pxPerPitch, 1e-4);
    const visibleBottom = topVisible - glCanvas.height / pxPer;
    let top = cam.topPitch;
    const lo = pitchMin - PITCH_MARGIN;
    const hi = pitchMax + PITCH_MARGIN;
    // if viewport taller than range, center it so the whole range is always visible
    if (visibleBottom < lo) top = lo + glCanvas.height / pxPer;
    else if (topVisible > hi) top = hi;
    return { ...cam, topPitch: top };
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
      camera = clampPitch({ ...camera, scrollTick: camera.scrollTick - dx / camera.pxPerTick, topPitch: camera.topPitch + dy / camera.pxPerPitch });
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
      const np = Math.max(0.5, Math.min(60, camera.pxPerPitch * f));
      camera = clampPitch({ ...camera, pxPerPitch: np, topPitch: anchorPitch + my / np });
    } else {
      const anchorTick = xToTick(camera, mx);
      const npx = Math.max(1e-4, Math.min(5, camera.pxPerTick * f));
      camera = { ...camera, pxPerTick: npx, scrollTick: anchorTick - mx / npx };
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
    renderer.draw(model, view);

    const oview: CameraView = { ...camera, viewportWidth: glCanvas.width, viewportHeight: glCanvas.height };
    const range = { left: oview.scrollTick, right: oview.scrollTick + oview.viewportWidth / oview.pxPerTick };
    const grid = gridConfig(4, 2, ppq, gridDiv);
    drawGridAndPlayhead(oCtx, oview, grid, range, playheadTick);
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