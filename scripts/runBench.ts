import { chromium } from 'playwright';

const durPerScenario = 4000;

async function main() {
  const headed = process.env.HEADED === '1';
  const browser = await chromium.launch({
    headless: !headed,
    args: headed ? [] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });

  // Confirm WebGL2 present
  const glOk = await page.evaluate(() => {
    const c = document.createElement('canvas');
    try { return !!c.getContext('webgl2'); } catch { return false; }
  });
  console.log('WebGL2 available in page:', glOk);

  await page.click('#runBtn');
  // Total expected time: 4 counts * 4 scenarios * durPerScenario ms
  const total = 4 * 4 * durPerScenario + 4000;
  await page.waitForSelector('#status:text("Complete")', { timeout: total + 30000 });

  const rows = await page.evaluate(() => {
    const trs = Array.from(document.querySelectorAll('#results tbody tr'));
    return trs.map((tr) =>
      Array.from(tr.querySelectorAll('td')).map((td) => td.textContent ?? '')
    );
  });
  console.table(rows);
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });