import { chromium } from 'playwright';

/**
 * RAII cleanup: the ambient chrome instance may still hold the page. Just verify
 * the server responds and Chrome can get the real 120Hz trajectory for the
 * AFTER state (to be run after the fix lands).
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
  console.log('window dpr:', await page.evaluate(() => window.devicePixelRatio));
  await page.click('#playBtn');
  await page.waitForTimeout(3500);
  const snap = await page.evaluate(() => (window as any).__tickDiag().snapshot);
  console.log(JSON.stringify(snap, null, 2));
  console.log('errors:', errs);
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });