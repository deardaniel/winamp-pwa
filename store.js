// Everything that persists on the phone. Audio goes in OPFS (it's the storage
// that hands back a disk-backed File without loading it into memory); track
// records, covers and settings go in IndexedDB.

let dbPromise;
function db() {
  return dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open("gapless-amp", 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore("tracks", { keyPath: "id" });
      req.result.createObjectStore("covers");
      req.result.createObjectStore("settings");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = t.onabort = () => reject(t.error);
  });
}

export const allTracks = () => tx("tracks", "readonly", s => s.getAll());
export const putTrack = t => tx("tracks", "readwrite", s => s.put(t));
export const deleteTrack = id => tx("tracks", "readwrite", s => s.delete(id));
export const getCover = id => tx("covers", "readonly", s => s.get(id));
export const putCover = (id, cover) => tx("covers", "readwrite", s => s.put(cover, id));
export const deleteCover = id => tx("covers", "readwrite", s => s.delete(id));
export const getSetting = key => tx("settings", "readonly", s => s.get(key));
export const setSetting = (key, value) => tx("settings", "readwrite", s => s.put(value, key));
export const deleteSetting = key => tx("settings", "readwrite", s => s.delete(key));

const audioDir = async () =>
  (await navigator.storage.getDirectory()).getDirectoryHandle("audio", { create: true });

/** A File backed by disk; slicing it reads only the bytes asked for. */
export async function audioFile(id) {
  return (await (await audioDir()).getFileHandle(id)).getFile();
}

export async function removeAudio(id) {
  try { await (await audioDir()).removeEntry(id); } catch {}
}

let worker, jobs = new Map(), nextJob = 1;
export function saveAudio(id, file) {
  if (!worker) {
    worker = new Worker("store-worker.js");
    worker.onmessage = ({ data }) => {
      const job = jobs.get(data.job);
      jobs.delete(data.job);
      data.ok ? job.resolve() : job.reject(new Error(data.message));
    };
  }
  return new Promise((resolve, reject) => {
    const job = nextJob++;
    jobs.set(job, { resolve, reject });
    worker.postMessage({ job, name: id, file });
  });
}

/** Asks the browser not to evict the library under storage pressure. */
export async function persist() {
  try { return await navigator.storage.persist(); } catch { return false; }
}

export async function usage() {
  try { return (await navigator.storage.estimate()).usage || 0; } catch { return 0; }
}
