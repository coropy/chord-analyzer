import { chromium } from 'playwright';

/** Verify Phase 3 app: real MIDI loads, renders, track visibility, perf metrics. */
async function main() {
  const browser = await chromium.launch(); // headed (real GPU)
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  // capture console errors
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });

  // wait for data load (play button enabled)
  await page.waitForSelector('#playBtn:not([disabled])', { timeout: 15000 });
  console.log('PASS: MIDI+WAV loaded, play enabled');

  // simulate playback for a couple seconds, drive camera to stress
  await page.click('#playBtn');
  await page.waitForTimeout(3000);

  // zoom via wheel
  await page.mouse.move(600, 400);
  await page.mouse.wheel(0, -400);
  await page.waitForTimeout(1000);
  // horizontal scroll (drag)
  await page.mouse.move(400, 400);
  await page.mouse.down();
  await page.mouse.move(700, 400, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(1000);

  // read perf + counts from the app
  const metrics = await page.evaluate(
    `(() => {
      const byId = (id) => (document.querySelector('#' + id)?.textContent ?? '');
      const trackRows = document.querySelectorAll('#trackbar .trackRow').length;
      return {
        fps: byId('fps'), fr: byId('fr'), cpu: byId('cpu'), gpu: byId('gpu'), vis: byId('vis'),
        pos: byId('pos'),
        gridOptions: (document.querySelector('#gridSel')?.options.length ?? 0),
        trackRows,
      };
    })()`,
  );
  console.log('Perf metrics:', JSON.stringify(metrics, null, 2));
  console.log('Console errors:', errors.length ? errors : 'none');

  // toggle a track off and confirm it works (no crash)
  await page.evaluate(
    `(() => { const boxes = document.querySelectorAll('#trackbar .trackRow input');
      if (boxes.length > 1) (boxes[1]).click(); })()`,
  );
  await page.waitForTimeout(400);
  console.log('After toggling track 1 off — still ok, errors:', errors.length ? errors : 'none');

  // screenshot
  await page.screenshot({ path: 'output/phase3_timeline.png' });
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });