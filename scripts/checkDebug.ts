import { chromium } from 'playwright';
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  p.on('pageerror', (e) => console.log('PAGEERR:', e.message));
  await p.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
  for (let i = 0; i < 20; i++) {
    const dbg = await p.evaluate(() => (window as any).__appDebug || null);
    const dis = await p.evaluate(() => document.querySelector('#playBtn')?.disabled);
    console.log(i, JSON.stringify(dbg), 'disabled=' + dis);
    if (!dis) break;
    await p.waitForTimeout(1000);
  }
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });