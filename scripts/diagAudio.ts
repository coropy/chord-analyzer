import { chromium } from 'playwright';
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  await p.goto('http://localhost:5173/');
  // Run the app's exact load steps, relative URLs, in page context.
  const out = await p.evaluate(async () => {
    const t0 = performance.now();
    let midiRes;
    try { midiRes = (await fetch('/data/nakanori_mt3.mid')).ok; } catch (e) { return { what: 'midi-fetch', e: String(e) }; }
    const r = await fetch('/data/nakanori_instrumental.wav');
    const t1 = performance.now();
    const arr = await r.arrayBuffer();
    const t2 = performance.now();
    const Ctx = (window.AudioContext || (window as any).webkitAudioContext) as any;
    const ctx = new Ctx();
    let decode = 'pending';
    const res = ctx.decodeAudioData(arr);
    const racer = Promise.race([
      res.then(() => (decode = 'ok'), (e: any) => (decode = 'ERR ' + (e?.message ?? e))),
      new Promise((r2) => setTimeout(() => (decode = 'TIMEOUT'), 20000)),
    ]);
    await racer;
    return { midi: midiRes, wavStatus: r.status, headMs: Math.round(t2 - t1),
      size: arr.byteLength, decode, wavFetchDone: !!r.status };
  });
  console.log(JSON.stringify(out));
  await b.close();
})().catch((e) => { console.error('TOP:', e); process.exit(1); });