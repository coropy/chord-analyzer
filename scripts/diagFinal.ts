import { chromium } from 'playwright';

/** One clean final measurement: steady-state (skips start + seek transient). */
async function main() {
  const browser = await chromium.launch({ headless: false, args: ['--start-maximized'] });
  const ctx = await browser.newContext({ viewport: null });
  const page = await ctx.newPage();
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
  await page.setInputFiles('#midiFile', 'C:/Users/alpha/OneDrive/デスクトップ/mt3/chord-analyzer/data/nakanori_mt3.mid');
  await page.waitForFunction(`(document.querySelector('#loadStatus')?.textContent ?? '').includes('notes')`);
  await page.setInputFiles('#audioFile', 'C:/Users/alpha/OneDrive/デスクトップ/mt3/chord-analyzer/data/nakanori_instrumental.wav');
  await page.waitForSelector('#playBtn:not([disabled])', { timeout: 60000 });

  await page.click('#playBtn');
  await page.waitForTimeout(1000);
  const box = await page.locator('#gl').boundingBox();
  await page.mouse.click(box!.x + box!.width * 0.7, box!.y + box!.height * 0.5);
  await page.waitForFunction(() => {
    const t = (document.querySelector('#pos') as HTMLElement).textContent ?? '';
    return parseFloat(t) > 25;
  }, { timeout: 40000 });
  await page.evaluate(() => (window as any).__tickDiag().snapshot && (window as any).__appCamera());

  const snap = await page.evaluate(async () => {
    const out: any[] = [];
    return new Promise<any[]>((resolve) => {
      let n = 0;
      const g = () => {
        const s = (window as any).__tickDiag().snapshot;
        out.push({ tick: s.playheadTick, scroll: s.scrollTick, px: s.playheadX, raf: s.rafMedianMs });
        n++;
        if (n < 300) requestAnimationFrame(g);
        else resolve(out);
      };
      requestAnimationFrame(g);
    });
  });

  const stat = (arr: number[]) => {
    const s = [...arr].sort((a, b) => a - b);
    const q = (f: number) => s[Math.min(s.length - 1, Math.floor(f * (s.length - 1)))];
    return {
      avg: s.reduce((a, b) => a + b, 0) / s.length,
      min: s[0], max: s[s.length - 1], p1: q(0.01), p99: q(0.99),
      zeroFrac: (arr.filter((v) => Math.abs(v) < 1e-9).length / arr.length) * 100,
    };
  };
  const dT: number[] = [], dS: number[] = [], dX: number[] = [];
  for (let i = 1; i < snap.length; i++) {
    dT.push(snap[i].tick - snap[i - 1].tick);
    dS.push(snap[i].scroll - snap[i - 1].scroll);
    dX.push(snap[i].px - snap[i - 1].px);
  }
  console.log('=== FINAL AFTER — steady-state mid-song (frames 1..299) ===');
  console.log('tick   :', JSON.stringify(stat(dT)));
  console.log('scroll :', JSON.stringify(stat(dS)));
  console.log('playheadX:', JSON.stringify(stat(dX)));
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });