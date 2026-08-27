// Temporary diagnostic: capture live rendered #gl canvas and verify notes are visible.
import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1100, height: 720 } });
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
  await page.waitForFunction(
    `(document.querySelector('#loadStatus')?.textContent ?? '').includes('notes')`,
    { timeout: 15000 },
  );
  await page.waitForTimeout(1500);

  const diag = await page.evaluate(() => {
    const g = document.querySelector('#gl') as HTMLCanvasElement;
    const gl = g.getContext('webgl2');
    const w = g.width, h = g.height;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    // count pixels matching note blue hue (r low, g high, b high)
    let notePx = 0;
    let minY = Infinity, maxY = -Infinity;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const r = px[i], ggt = px[i + 1], b = px[i + 2];
        if (b > 200 && ggt > 140 && r < 120) {
          notePx++;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    return {
      vis: document.querySelector('#vis')?.textContent?.trim(),
      status: document.querySelector('#loadStatus')?.textContent?.trim(),
      canvasStr: g.width + 'x' + g.height,
      notePixels: notePx,
      minY, maxY, h,
      backgroundColorSample: Array.from(px.subarray(0, 40)),
    };
  });
  console.log('DIAG', JSON.stringify(diag));
  console.log('console errors:', JSON.stringify(errors, null, 2));
  await page.screenshot({ path: 'output/tmp_diag.png' });
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });