import './style.css';
import { WebGL2NoteRenderer } from './renderer/WebGL2NoteRenderer';
import { WebGL2Benchmark, type BenchmarkResult, type Scenario } from './bench/benchmark';

const COUNTS = [10_000, 100_000, 500_000, 1_000_000];
const SCENARIOS: Scenario[] = ['idle', 'play', 'zoom', 'alldrive'];
const DURATION = 4000;

function mount(root: HTMLElement): void {
  root.innerHTML = `
    <div id="wrap">
      <div id="topbar">
        <button id="runBtn">▶ Benchmark</button>
        <span id="status">Ready</span>
        <span id="noteinfo"></span>
      </div>
      <canvas id="glcanvas"></canvas>
      <div id="tableWrap">
        <table id="results">
          <thead><tr>
            <th>notes</th><th>scenario</th><th>avgFPS</th><th>avg ms</th>
            <th>1% low ms</th><th>0.1% low ms</th>
            <th>CPU upd ms</th><th>GPU draw ms</th>
            <th>vis avg</th><th>vis peak</th>
          </tr></thead>
          <tbody></tbody>
        </table>
      </div>
    </div>`;

  const canvas = root.querySelector('#glcanvas') as HTMLCanvasElement;
  const resize = (): void => {
    const topbar = root.querySelector('#topbar') as HTMLElement;
    const h = root.clientHeight - topbar.offsetHeight;
    canvas.width = root.clientWidth;
    canvas.height = Math.max(h, 200);
  };
  resize();
  window.addEventListener('resize', resize);

  const gl = canvas.getContext('webgl2', { antialias: true, alpha: false });
  if (!gl) {
    (root.querySelector('#status') as HTMLElement).textContent = 'WebGL2 not supported';
    return;
  }
  gl.clearColor(0.09, 0.10, 0.13, 1);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  const renderer = new WebGL2NoteRenderer(gl);
  const bench = new WebGL2Benchmark(canvas, renderer);
  const tbody = root.querySelector('tbody')!;
  const status = root.querySelector('#status') as HTMLElement;
  const noteinfo = root.querySelector('#noteinfo') as HTMLElement;
  const btn = root.querySelector('#runBtn') as HTMLElement;

  const addRow = (r: BenchmarkResult): void => {
    const s = r.stats;
    const cells = [
      r.count.toLocaleString('en-US'), r.scenario,
      s.avgFps.toFixed(1), s.avgMs.toFixed(2),
      s.p1LowMs.toFixed(3), s.p01LowMs.toFixed(3),
      r.cpuAvgMs.toFixed(3), r.gpuAvgMs.toFixed(3),
      r.avgVisible.toFixed(0), r.peakVisible.toLocaleString('en-US'),
    ];
    const tr = document.createElement('tr');
    for (const c of cells) {
      const td = document.createElement('td');
      td.textContent = String(c);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  };

  btn.addEventListener('click', async () => {
    (btn as HTMLButtonElement).disabled = true;
    tbody.innerHTML = '';
    for (const count of COUNTS) {
      status.textContent = `Uploading ${count.toLocaleString('en-US')} notes…`;
      noteinfo.textContent = `${count.toLocaleString('en-US')} notes`;
      bench.upload(count);
      for (const scenario of SCENARIOS) {
        status.textContent = `Run: ${count.toLocaleString('en-US')} / ${scenario}`;
        const result = await bench.runScenario(scenario, DURATION);
        if (result) addRow(result);
      }
      status.textContent = `Finished ${count.toLocaleString('en-US')}`;
      // allow a moment for the browser to settle / GC
      await new Promise((r) => setTimeout(r, 200));
    }
    status.textContent = 'Complete';
    (btn as HTMLButtonElement).disabled = false;
  });
}

mount(document.getElementById('app')!);