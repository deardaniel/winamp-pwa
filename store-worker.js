// Copies an imported file into the app's private storage (OPFS). This lives in
// a worker because Safari has long only allowed OPFS writes through a sync
// access handle, and those only exist in workers.
self.onmessage = async ({ data: { job, name, file } }) => {
  let handle;
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle("audio", { create: true });
    const fh = await dir.getFileHandle(name, { create: true });
    handle = await fh.createSyncAccessHandle();
    await handle.truncate(0);
    const STEP = 4 << 20;
    for (let at = 0; at < file.size; at += STEP) {
      const buf = new Uint8Array(await file.slice(at, at + STEP).arrayBuffer());
      await handle.write(buf, { at });
    }
    await handle.flush();
    self.postMessage({ job, ok: true });
  } catch (err) {
    self.postMessage({ job, ok: false, message: String(err && err.message || err) });
  } finally {
    if (handle) await handle.close();
  }
};
