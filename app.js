import Webamp from "./vendor/webamp.bundle.min.mjs";
import { GaplessMedia, sources, setUpcoming, outputMode } from "./media.js";
import { readTags, groupAlbums } from "./tags.js";
import * as store from "./store.js";

const $ = id => document.getElementById(id);
const WIDTH = 275;       // a Winamp window, in skin pixels
const WINDOW_H = 116;    // main and equalizer are each this tall
const ROW_H = 29;        // the playlist grows in steps of this

/* ---- Webamp, scaled to fill the screen ---- */

// The skin is a fixed-size bitmap, so the three windows are stacked in a
// 275px-wide column and the column is zoomed until it spans the display.
function layout() {
  const scale = Math.min(window.innerWidth / WIDTH, 3);
  const bar = $("bar").getBoundingClientRect().height;
  const safeTop = parseFloat(getComputedStyle($("stage")).paddingTop) || 0; // the notch
  const room = (window.innerHeight - safeTop - bar) / scale - WINDOW_H * 3;
  return { scale, safeTop, extraRows: Math.max(0, Math.floor(room / ROW_H)) };
}

// Webamp centres its windows in the node it's given, measuring in unzoomed
// pixels. So hand it a box exactly the size of the column, placed where the
// column should sit once zoomed, and the centring works out to no offset.
function placeStage({ scale, safeTop, extraRows }) {
  const stage = $("stage");
  stage.style.paddingTop = 0; // measured already; it would skew the centring
  stage.style.top = `${safeTop / scale}px`;
  stage.style.width = `${WIDTH}px`;
  stage.style.height = `${WINDOW_H * 3 + extraRows * ROW_H}px`;
}

const fit = layout();
const { extraRows } = fit;
placeStage(fit);
const savedSkin = await store.getSetting("skin").catch(() => null);

const webamp = new Webamp({
  __customMediaClass: GaplessMedia,
  enableMediaSession: true,
  ...(savedSkin ? { initialSkin: { url: URL.createObjectURL(new Blob([savedSkin])) } } : {}),
  windowLayout: {
    main: { position: { top: 0, left: 0 } },
    equalizer: { position: { top: WINDOW_H, left: 0 } },
    playlist: { position: { top: WINDOW_H * 2, left: 0 }, size: { extraHeight: extraRows, extraWidth: 0 } },
  },
});
const media = webamp.media;

await webamp.renderWhenReady($("stage"));
const root = document.getElementById("webamp");
const applyScale = () => { root.style.zoom = Math.min(window.innerWidth / WIDTH, 3); };
applyScale();
window.addEventListener("resize", applyScale);

/* ---- telling the audio engine what comes next ---- */

const urlOf = (state, id) => state.tracks[id] && state.tracks[id].url;

setUpcoming(() => {
  const state = webamp.store.getState();
  const { trackOrder, currentTrack } = state.playlist;
  // Shuffle picks its next track at the last moment; there's nothing to join ahead of time.
  if (state.media.shuffle || currentTrack == null) return [];
  const i = trackOrder.indexOf(currentTrack);
  const after = trackOrder.slice(i + 1);
  const order = state.media.repeat ? after.concat(trackOrder.slice(0, i + 1)) : after;
  return order.map(id => urlOf(state, id)).filter(Boolean);
});

let seen = {};
webamp.store.subscribe(() => {
  const { playlist, media: m } = webamp.store.getState();
  if (seen.order === playlist.trackOrder && seen.shuffle === m.shuffle && seen.repeat === m.repeat) return;
  seen = { order: playlist.trackOrder, shuffle: m.shuffle, repeat: m.repeat };
  media.refreshQueue();
});

// Webamp reports every file as 128 kbps / 44 kHz. Correct it once it has.
media.on("fileLoaded", () => {
  const info = media.info();
  const id = webamp.store.getState().playlist.currentTrack;
  if (!info || id == null) return;
  webamp.store.dispatch({
    type: "SET_MEDIA", id,
    kbps: String(info.bitrate || 128),
    khz: String(Math.round((info.sampleRate || 44100) / 1000)),
    channels: info.channels || 2,
    length: info.duration,
  });
});

// Lock-screen scrubber. The <audio> element is playing an endless stream, so
// without this iOS has no idea how long the track is.
if ("mediaSession" in navigator) {
  let last = 0;
  media.on("timeupdate", () => {
    const now = performance.now();
    if (now - last < 1000) return;
    last = now;
    const duration = media.duration();
    if (!(duration > 0)) return;
    try {
      navigator.mediaSession.setPositionState({
        duration, playbackRate: 1, position: Math.min(media.timeElapsed(), duration),
      });
    } catch {}
  });
  try {
    navigator.mediaSession.setActionHandler("seekto", e => webamp.seekToTime(e.seekTime));
    navigator.mediaSession.setActionHandler("stop", () => webamp.stop());
  } catch {}
}

webamp.onTrackDidChange(track => {
  const m = track && track.metaData;
  $("now").textContent = m ? [m.artist, m.title].filter(Boolean).join(" - ") : "";
});

/* ---- library ---- */

let albums = [];
const coverUrls = new Map();
let playlistUrls = [];

async function coverUrl(id) {
  if (!id) return null;
  if (!coverUrls.has(id)) {
    const c = await store.getCover(id);
    coverUrls.set(id, c ? URL.createObjectURL(new Blob([c.data], { type: c.mime })) : null);
  }
  return coverUrls.get(id);
}

const clock = s => {
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m} min`;
};

async function refresh() {
  albums = groupAlbums(await store.allTracks());
  const list = $("albums");
  list.textContent = "";
  if (!albums.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No music yet. Tap Add MP3s and pick the files for an album - they are copied onto this device and sorted by their tags.";
    list.append(li);
  }
  for (const album of albums) {
    const li = document.createElement("li");
    li.dataset.key = album.key;
    const art = document.createElement(album.coverId ? "img" : "div");
    if (album.coverId) { art.alt = ""; coverUrl(album.coverId).then(u => { if (u) art.src = u; }); }
    else { art.className = "nocover"; art.textContent = "♪"; }
    const meta = document.createElement("div");
    meta.className = "meta";
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = album.title;
    const sub = document.createElement("div");
    sub.className = "sub";
    sub.textContent = [album.artist, album.year, `${album.tracks.length} tracks`, clock(album.duration)]
      .filter(Boolean).join(" · ");
    meta.append(title, sub);
    const del = document.createElement("button");
    del.className = "del";
    del.type = "button";
    del.textContent = "Delete";
    li.append(art, meta, del);
    list.append(li);
  }
  const mb = (await store.usage()) / 1048576;
  $("usage").textContent = albums.length
    ? `${albums.length} album${albums.length === 1 ? "" : "s"} · ${mb >= 1000 ? (mb / 1024).toFixed(1) + " GB" : Math.round(mb) + " MB"}`
    : "";
}

async function toWebampTracks(album) {
  const art = await coverUrl(album.coverId);
  const out = [];
  for (const t of album.tracks) {
    const file = await store.audioFile(t.id);
    const url = URL.createObjectURL(file);
    sources.set(url, { file, duration: t.duration, sampleRate: t.sampleRate, channels: t.channels, bitrate: t.bitrate });
    out.push({
      url,
      duration: t.duration,
      metaData: {
        artist: t.artist || album.artist,
        title: t.title || t.fileName.replace(/\.mp3$/i, ""),
        album: album.title,
        ...(art ? { albumArtUrl: art } : {}),
      },
    });
  }
  return out;
}

function retire(urls) {
  for (const url of urls) { sources.delete(url); URL.revokeObjectURL(url); }
}

async function openAlbum(album, autoPlay) {
  const tracks = await toWebampTracks(album);
  const old = playlistUrls;
  playlistUrls = tracks.map(t => t.url);
  if (autoPlay) webamp.setTracksToPlay(tracks);
  else webamp.appendTracks(tracks);
  retire(old);
  store.setSetting("lastAlbum", album.key).catch(() => {});
}

async function deleteAlbum(album) {
  for (const t of album.tracks) {
    await store.deleteTrack(t.id);
    await store.removeAudio(t.id);
  }
  // Covers are shared by an album's tracks, so only drop ones nothing points at now.
  const used = new Set((await store.allTracks()).map(t => t.coverId));
  for (const id of new Set(album.tracks.map(t => t.coverId).filter(Boolean)))
    if (!used.has(id)) { await store.deleteCover(id); coverUrls.delete(id); }
}

// Phone-sized album art: full-size scans are megabytes each and only ever shown small.
async function shrink(picture) {
  const blob = new Blob([picture.data], { type: picture.mime });
  try {
    const bmp = await createImageBitmap(blob);
    const k = Math.min(1, 600 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * k);
    canvas.height = Math.round(bmp.height * k);
    canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const out = await new Promise(r => canvas.toBlob(r, "image/jpeg", 0.85));
    if (out) return { mime: "image/jpeg", data: await out.arrayBuffer() };
  } catch {}
  return { mime: picture.mime, data: picture.data.buffer.slice(picture.data.byteOffset, picture.data.byteOffset + picture.data.byteLength) };
}

async function importFiles(files) {
  const status = $("status");
  const existing = await store.allTracks();
  const have = new Set(existing.map(t => `${t.fileName}/${t.size}`));
  const covers = new Set(existing.map(t => t.coverId).filter(Boolean));
  let added = 0, skipped = 0, failed = 0;
  await store.persist();

  for (const [i, file] of files.entries()) {
    status.textContent = `Importing ${i + 1} of ${files.length}: ${file.name}`;
    if (have.has(`${file.name}/${file.size}`)) { skipped++; continue; }
    try {
      const tags = await readTags(file);
      if (!tags.duration) throw new Error("not an MP3");
      const id = crypto.randomUUID();
      await store.saveAudio(id, file);

      let coverId = null;
      if (tags.picture) {
        // One stored cover per distinct picture per album, not one per track.
        coverId = `${(tags.album || "").toLowerCase()}/${tags.picture.data.length}`;
        if (!covers.has(coverId)) {
          await store.putCover(coverId, await shrink(tags.picture));
          covers.add(coverId);
        }
      }
      const { picture, ...rest } = tags;
      await store.putTrack({ id, fileName: file.name, size: file.size, coverId, added: Date.now(), ...rest });
      have.add(`${file.name}/${file.size}`);
      added++;
    } catch (err) {
      console.warn("import failed:", file.name, err);
      failed++;
    }
  }
  status.textContent = [
    `Added ${added} track${added === 1 ? "" : "s"}`,
    skipped && `${skipped} already here`,
    failed && `${failed} could not be read`,
  ].filter(Boolean).join(", ") + ".";
  await refresh();
}

/* ---- controls ---- */

const sheet = $("library");
$("open-library").onclick = () => { sheet.hidden = false; refresh(); };
$("close-library").onclick = () => { sheet.hidden = true; sheet.classList.remove("editing"); };
$("edit").onclick = () => sheet.classList.toggle("editing");
$("add").onclick = () => $("pick-mp3").click();
$("pick-mp3").onchange = async e => {
  const files = [...e.target.files];
  e.target.value = "";
  if (files.length) await importFiles(files);
};

$("albums").onclick = async e => {
  const li = e.target.closest("li[data-key]");
  if (!li) return;
  const album = albums.find(a => a.key === li.dataset.key);
  if (!album) return;
  if (e.target.classList.contains("del")) {
    if (!confirm(`Delete "${album.title}" from this device?`)) return;
    await deleteAlbum(album);
    await refresh();
    return;
  }
  if (sheet.classList.contains("editing")) return;
  media.unlock(); // still inside the tap; the awaits below would lose it
  sheet.hidden = true;
  await openAlbum(album, true);
};

$("skin").onclick = () => $("pick-skin").click();
$("pick-skin").onchange = async e => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const data = await file.arrayBuffer();
  // A .wsz is a zip; anything else would leave Webamp half-skinned.
  if (new Uint8Array(data, 0, 2).join() !== "80,75") {
    $("status").textContent = `${file.name} is not a Winamp skin (.wsz).`;
    return;
  }
  await store.setSetting("skin", data);
  webamp.setSkinFromUrl(URL.createObjectURL(new Blob([data])));
  $("status").textContent = `Skin: ${file.name}`;
  sheet.hidden = true;
};
$("skin-reset").onclick = async () => {
  await store.deleteSetting("skin");
  location.reload();
};

const outButton = $("out-mode");
outButton.textContent = `Audio: ${outputMode() === "element" ? "background" : "direct"}`;
outButton.onclick = () => {
  localStorage.setItem("gapless.out", outputMode() === "element" ? "direct" : "element");
  location.reload();
};

/* ---- startup ---- */

await refresh();
const last = await store.getSetting("lastAlbum").catch(() => null);
const resume = albums.find(a => a.key === last);
if (resume) await openAlbum(resume, false);
else if (!albums.length) sheet.hidden = false;

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

// For tests and poking around in the console.
window.amp = { webamp, media, store, importFiles, refresh, albums: () => albums };
