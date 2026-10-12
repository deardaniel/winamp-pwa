// End-to-end check, run in a real browser through Playwright:
//   imports the fixtures the way the file picker would, plays the album, records
//   what reaches the audio graph and compares it with the original sine.
// Start `python3 serve.py <port>` and `test/make-fixtures.sh` first.
async (page) => {
  const base = page.url().startsWith("http") ? new URL("/", page.url()).href : "http://localhost:8080/";
  await page.goto(base);
  await page.evaluate(async () => {
    for (const reg of await navigator.serviceWorker.getRegistrations()) await reg.unregister();
    indexedDB.deleteDatabase("gapless-amp");
    const root = await navigator.storage.getDirectory();
    for await (const name of root.keys()) await root.removeEntry(name, { recursive: true });
    localStorage.clear();
  });
  await page.goto(base);
  await page.waitForFunction(() => window.amp);

  const imported = await page.evaluate(async () => {
    // Deliberately out of order and misnamed: only the tags should matter.
    const names = { "p3.mp3": "aaa.mp3", "p1.mp3": "zzz.mp3", "p2.mp3": "mmm.mp3", "v24.mp3": "v24.mp3", "bare.mp3": "bare.mp3" };
    const files = [];
    for (const [src, as] of Object.entries(names))
      files.push(new File([await (await fetch("test/fixtures/" + src)).blob()], as, { type: "audio/mpeg" }));
    await amp.importFiles(files);
    return amp.albums().map(a => `${a.artist} / ${a.title}: ${a.tracks.map(t => t.title || t.fileName).join(", ")}`);
  });

  await page.evaluate(() => {
    const m = amp.media, ctx = m._ctx;
    const tap = ctx.createScriptProcessor(4096, 2, 1);
    window.rec = [];
    window.trail = [];
    tap.onaudioprocess = e => window.rec.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    m._input.connect(tap);
    tap.connect(ctx.destination);
    const load = m.loadFromUrl.bind(m);
    m.loadFromUrl = (url, auto) => { window.trail.push(m._adopting === url ? "joined" : "started"); return load(url, auto); };
  });
  await page.click("#albums li[data-key] .title >> text=Gap Test");
  await page.waitForTimeout(6000);
  const midway = await page.evaluate(() => ({
    track: amp.webamp.store.getState().playlist.currentTrack,
    elapsed: +amp.media.timeElapsed().toFixed(1),
    now: document.getElementById("now").textContent,
  }));
  await page.waitForTimeout(7500);

  const audio = await page.evaluate(async () => {
    const raw = new Float32Array(await (await fetch("test/fixtures/full.raw")).arrayBuffer());
    const n = window.rec.reduce((a, b) => a + b.length, 0), pcm = new Float32Array(n);
    let p = 0;
    for (const b of window.rec) { pcm.set(b, p); p += b.length; }
    let first = 0;
    while (first < n && Math.abs(pcm[first]) < 1e-4) first++;
    let off = 0, best = Infinity;
    for (let o = Math.max(0, first - 40); o <= first + 5; o++) {
      let e = 0;
      for (let k = 2000; k < 40000; k++) e += (pcm[o + k] - raw[k]) ** 2;
      if (e < best) { best = e; off = o; }
    }
    const err = (a, b) => { let m = 0; for (let k = a; k < b; k++) m = Math.max(m, Math.abs(pcm[off + k] - raw[k])); return +m.toFixed(4); };
    let last = n - 1;
    while (last > 0 && Math.abs(pcm[last]) < 1e-4) last--;
    return {
      trail: window.trail, status: amp.webamp.getMediaStatus(),
      samplesPlayed: last - off + 1, samplesInSource: raw.length,
      errMid: err(50000, 100000), errJoin1: err(148000, 152000), errJoin2: err(331000, 335000), errWhole: err(0, raw.length - 100),
    };
  });

  const ok = audio.trail.join() === "started,joined,joined" && audio.errWhole < 0.03 &&
    // The codec rings on for a few hundred samples after the last track; one
    // ungapped join would add over a thousand.
    Math.abs(audio.samplesPlayed - audio.samplesInSource) < 512 && audio.status === "STOPPED" && midway.track != null;
  return { result: ok ? "PASS" : "FAIL", imported, midway, audio };
}
