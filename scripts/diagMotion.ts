import { chromium } from 'playwright';

/**
 * Measure MOTION UNIFORMITY on the real 120Hz display:
 * per-frame ΔvisualTick, ΔscrollTick, ΔplayheadX (screen px) + presentation
 * internals (velocity, calibration) over ~600 frames in the mid-song settle
 * region where camera follow is active.
 */
async function main() {
  const browser = await chromium.launch({ headless: false, args: ['--start-maximized'] });
  const ctx = await browser.newContext({ viewport: null });
  const page = await ctx.newPage();
  const errs: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
  await page.setInputFiles('#midiFile', 'C:/Users/alpha/OneDrive/デスクトップ/mt3/chord-analyzer/data/nakanori_mt3.mid');
  await page.waitForFunction(`(document.querySelector('#loadStatus')?.textContent ?? '').includes('notes')`);
  await page.setInputFiles('#audioFile', 'C:/Users/alpha/OneDrive/デスクトップ/mt3/chord-analyzer/data/nakanori_instrumental.wav');
  await page.waitForSelector('#playBtn:not([disabled])', { timeout: 60000 });

  await page.click('#playBtn');
  await page.waitForTimeout(1200);
  const box = await page.locator('#gl').boundingBox();
  await page.mouse.click(box!.x + box!.width * 0.7, box!.y + box!.height * 0.5);
  await page.waitForFunction(() => {
    const t = (document.querySelector('#pos') as HTMLElement).textContent ?? '';
    return parseFloat(t) > 25;
  }, { timeout: 40000 });
  // let the clock calibrate (>3s) before capture
  await page.waitForTimeout(3500);

  const snap = await page.evaluate(async () => {
    const out: any[] = [];
    let last = performance.now();
    return new Promise<any[]>((resolve) => {
      let n = 0;
      const g = () => {
        const now = performance.now();
        const s = (window as any).__tickDiag().snapshot;
        out.push({
          raf: now - last, now,
          tick: s.playheadTick,
          scroll: s.scrollTick,
          px: s.playheadX,
          pvt: s.present.velocity,
          calibN: s.present.calibN,
          err: s.present.err,
        });
        last = now;
        n++;
        if (n < 600) requestAnimationFrame(g);
        else resolve(out);
      };
      requestAnimationFrame(g);
    });
  });

  const stat = (arr: number[]) => {
    const s = [...arr].sort((a, b) => a - b);
    const q = (f: number) => s[Math.min(s.length - 1, Math.floor(f * (s.length - 1)))];
    const avg = s.reduce((a, b) => a + b, 0) / s.length;
    let ss = 0; for (const v of arr) ss += (v - avg) ** 2;
    const std = Math.sqrt(ss / arr.length);
    return {
      avg: +avg.toFixed(4), median: +s[Math.floor(s.length / 2)].toFixed(4),
      min: +s[0].toFixed(4), max: +s[s.length - 1].toFixed(4),
      p1: +q(0.01).toFixed(4), p99: +q(0.99).toFixed(4),
      std: +std.toFixed(4),
      maxPosDev: +(Math.max(...arr.map((v) => v - avg))).toFixed(4),
      maxNegDev: +(Math.min(...arr.map((v) => v - avg))).toFixed(4),
      zeroFrac: +((arr.filter((v) => Math.abs(v) < 1e-9).length / arr.length) * 100).toFixed(2),
    };
  };

  const dT: number[] = [], dS: number[] = [], dX: number[] = [], dRaf: number[] = [];
  for (let i = 1; i < snap.length; i++) {
    dT.push(snap[i].tick - snap[i - 1].tick);
    dS.push(snap[i].scroll - snap[i - 1].scroll);
    dX.push(snap[i].px - snap[i - 1].px);
    dRaf.push(snap[i].raf);
  }

  console.log('=== MOTION UNIFORMITY — real 120Hz, mid-song, after calibration ===');
  console.log('frames:', snap.length);
  console.log('velocity:', snap[snap.length - 1].pvt.toFixed(5), 'calibN:', snap[snap.length - 1].calibN, 'err:', snap[snap.length - 1].err.toFixed(5));
  console.log('Δtick :', JSON.stringify(stat(dT)));
  console.log('Δscroll:', JSON.stringify(stat(dS)));
  console.log('Δpx   :', JSON.stringify(stat(dX)));
  console.log('Δraf  :', JSON.stringify(stat(dRaf)));

  // cadence pattern sample
  console.log('first 20 Δtick:', dT.slice(0, 20).map((v) => v.toFixed(3)).join(', '));
  console.log('errors:', errs.length ? errs : 'none');
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });