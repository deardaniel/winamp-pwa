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
  document.documentElement.style.setProperty("--scale", scale); // the bar is drawn in skin pixels too
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
  // The playlist's ADD URL / LOAD LIST / SAVE LIST buttons (see "playlist buttons" below).
  handleAddUrlEvent: () => addUrl(),
  handleLoadListEvent: () => loadList(),
  handleSaveListEvent: tracks => saveList(tracks),
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

/* ---- skin windows ---- */

// The library and the dialogs are Webamp "generic" windows: the markup its own
// extra windows use, placed inside its root. So whichever skin is loaded draws
// their frame and title lettering, at the same zoom as the player.
function genWindow(el, name) {
  const div = (cls, ...kids) => {
    const d = document.createElement("div");
    d.className = cls;
    d.append(...kids);
    return d;
  };
  const title = div("gen-top-title");
  title.id = `${name}-title`;
  const close = document.createElement("button");
  close.type = "button";
  close.id = `close-${name}`;
  close.className = "gen-close";
  close.setAttribute("aria-label", "Close");
  const centre = div("gen-middle-center", ...el.children);
  el.classList.add("gen-window", "selected");
  el.append(
    div("gen-top", div("gen-top-left"), div("gen-top-left-fill"), div("gen-top-left-end"), title,
      div("gen-top-right-end"), div("gen-top-right-fill"), div("gen-top-right", close)),
    div("gen-middle", div("gen-middle-left", div("gen-middle-left-bottom")), centre,
      div("gen-middle-right", div("gen-middle-right-bottom"))),
    div("gen-bottom", div("gen-bottom-left"), div("gen-bottom-right")));
}
genWindow($("library"), "library");
genWindow($("dialog").firstElementChild, "dialog");
root.append($("library"), $("dialog"));

// Title bars are lettered from the skin's bitmap font, which only has A-Z.
function setTitle(el, text) {
  el.setAttribute("aria-label", text);
  el.textContent = "";
  for (const ch of text.toLowerCase()) {
    if (!/[a-z ]/.test(ch)) continue;
    const letter = document.createElement("div");
    letter.className = `gen-text-letter gen-text-${ch === " " ? "space" : ch}`;
    el.append(letter);
  }
}

// The bar would sit on top of a window in Webamp's root, so it steps aside.
const sheetOpen = () => document.body.classList.toggle("sheet-open", !$("library").hidden || !$("dialog").hidden);

// Lists inside those windows take the playlist editor's colours from the skin.
let playlistStyle;
function paint() {
  const style = webamp.store.getState().display.skinPlaylistStyle;
  if (style === playlistStyle) return;
  playlistStyle = style;
  for (const [name, key] of [["normal", "normal"], ["current", "current"], ["bg", "normalbg"], ["selbg", "selectedbg"], ["font", "font"]]) {
    if (style && style[key]) root.style.setProperty(`--pl-${name}`, style[key]);
    else root.style.removeProperty(`--pl-${name}`);
  }
}
paint();
webamp.store.subscribe(paint);

// The playlist only resizes in whole 29px steps, which leaves a strip of dead
// space above the bar. Its side borders tile, so pin its height to the exact
// remainder instead. A stylesheet rule, because Webamp rewrites the inline one.
const exactHeight = document.head.appendChild(document.createElement("style"));
let rows = fit.extraRows;
function refit() {
  const now = { ...layout(), safeTop: fit.safeTop };
  root.style.zoom = now.scale;
  const bar = $("bar").getBoundingClientRect().height;
  const room = (window.innerHeight - now.safeTop - bar) / now.scale - WINDOW_H * 2;
  const wantRows = Math.max(0, Math.floor((room - WINDOW_H) / ROW_H));
  if (wantRows !== rows) {
    rows = wantRows;
    webamp.store.dispatch({ type: "WINDOW_SIZE_CHANGED", windowId: "playlist", size: [0, rows] });
  }
  exactHeight.textContent = room > WINDOW_H ? `#webamp #playlist-window { height: ${room}px !important; }` : "";
}
refit();
window.addEventListener("resize", refit);
if (window.visualViewport) window.visualViewport.addEventListener("resize", refit);

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
  const orderChanged = seen.order !== playlist.trackOrder;
  seen = { order: playlist.trackOrder, shuffle: m.shuffle, repeat: m.repeat };
  media.refreshQueue();
  if (orderChanged) sweep();
  // Tracks added to an idle player have no "current" one, and Play then does
  // nothing at all. Cue the first so Play has something to start.
  // Deferred: when an album is opened to play, Webamp picks its own current
  // track in the same breath as adding it.
  setTimeout(() => {
    const now = webamp.store.getState();
    if (now.media.status === "STOPPED" && now.playlist.currentTrack == null && now.playlist.trackOrder.length)
      webamp.store.dispatch({ type: "BUFFER_TRACK", id: now.playlist.trackOrder[0] });
  }, 0);
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

// Builds Webamp tracks for library records. Each gets a blob URL onto its file
// in storage; `sources` is how the audio engine (and the buttons below) get
// from that URL back to the file and its record.
const building = new Set();
async function webampTracks(records) {
  const out = [];
  for (const t of records) {
    const file = await store.audioFile(t.id);
    const url = URL.createObjectURL(file);
    building.add(url);
    sources.set(url, { file, rec: t, duration: t.duration, sampleRate: t.sampleRate, channels: t.channels, bitrate: t.bitrate });
    const art = await coverUrl(t.coverId);
    out.push({
      url,
      duration: t.duration,
      metaData: {
        artist: t.artist || t.albumArtist || "Unknown Artist",
        title: t.title || t.fileName.replace(/\.mp3$/i, ""),
        album: t.album || "Unknown Album",
        ...(art ? { albumArtUrl: art } : {}),
      },
    });
  }
  // Released once the playlist has had a chance to take them (see sweep()).
  setTimeout(() => { for (const t of out) building.delete(t.url); sweep(); }, 2000);
  return out;
}

const playlistUrlSet = () => {
  const state = webamp.store.getState();
  return new Set(state.playlist.trackOrder.map(id => urlOf(state, id)));
};

// Blob URLs pin their file open, so drop the ones no playlist entry uses any more.
function sweep() {
  const live = playlistUrlSet();
  for (const [url, entry] of sources)
    if (entry.rec && !live.has(url) && !building.has(url)) { sources.delete(url); URL.revokeObjectURL(url); }
}

async function openAlbum(album, how) {
  const tracks = await webampTracks(album.tracks);
  if (how === "play") {
    webamp.setTracksToPlay(tracks);
    store.setSetting("lastAlbum", album.key).catch(() => {});
  } else webamp.appendTracks(tracks);
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
  const byFile = new Map(existing.map(t => [`${t.fileName}/${t.size}`, t]));
  const picked = [];
  let added = 0, skipped = 0, failed = 0;
  await store.persist();

  for (const [i, file] of files.entries()) {
    status.textContent = `Importing ${i + 1} of ${files.length}: ${file.name}`;
    if (have.has(`${file.name}/${file.size}`)) { skipped++; picked.push(byFile.get(`${file.name}/${file.size}`)); continue; }
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
      const rec = { id, fileName: file.name, size: file.size, coverId, added: Date.now(), ...rest };
      await store.putTrack(rec);
      byFile.set(`${file.name}/${file.size}`, rec);
      picked.push(rec);
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
  return picked;
}

/* ---- controls ---- */

const sheet = $("library");
// The library opens either to play an album or, from the playlist's ADD DIR, to queue one.
let sheetAdds = false;
function openLibrary(adds = false) {
  sheetAdds = adds;
  setTitle($("library-title"), adds ? "Add album to playlist" : "Media Library");
  sheet.hidden = false;
  sheetOpen();
  refresh();
}
function closeLibrary() {
  sheet.hidden = true;
  sheet.classList.remove("editing");
  sheetOpen();
}
$("open-library").onclick = () => openLibrary();
$("close-library").onclick = closeLibrary;
$("edit").onclick = () => sheet.classList.toggle("editing");

// Picked files always join the library; from the playlist's ADD FILE they are queued too.
let pickedGoTo = "library";
function pickFiles(goTo) {
  pickedGoTo = goTo;
  $("pick-mp3").click();
}
$("add").onclick = () => pickFiles("library");
$("pick-mp3").onchange = async e => {
  const files = [...e.target.files];
  e.target.value = "";
  if (!files.length) return;
  const queue = pickedGoTo === "playlist";
  if (queue) openLibrary(); // somewhere to show import progress
  const picked = await importFiles(files);
  if (queue && picked.length) {
    // Tag order, not the order the picker happened to return them in.
    webamp.appendTracks(await webampTracks(groupAlbums(picked).flatMap(a => a.tracks)));
    closeLibrary();
  }
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
  const adds = sheetAdds;
  if (!adds) media.unlock(); // still inside the tap; the awaits below would lose it
  closeLibrary();
  await openAlbum(album, adds ? "append" : "play");
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
  closeLibrary();
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

/* ---- playlist buttons ---- */

// Webamp ships several of the playlist editor's buttons as "Not supported", and
// its file buttons open a picker whose files would bypass the library. Those
// taps are caught here, before Webamp's own handlers see them.

function dialog(title, build) {
  return new Promise(resolve => {
    const box = $("dialog"), body = $("dialog-body");
    setTitle($("dialog-title"), title);
    body.textContent = "";
    const done = value => { box.hidden = true; sheetOpen(); resolve(value); };
    build(body, done);
    $("close-dialog").onclick = () => done(null);
    box.hidden = false;
    sheetOpen();
  });
}
const notice = (title, text) => dialog(title, body => {
  const p = document.createElement("p");
  p.textContent = text;
  body.append(p);
});

const currentState = () => webamp.store.getState();
const recOf = (state, id) => (sources.get(urlOf(state, id)) || {}).rec;

// ADD URL
async function addUrl() {
  const url = (prompt("Address of an MP3 to add:") || "").trim();
  if (!url) return null;
  try { new URL(url); } catch { await notice("Add URL", "That is not a valid address."); return null; }
  const name = decodeURIComponent(new URL(url).pathname.split("/").pop() || "") || url;
  return [{ url, defaultName: name }];
}

// LIST OPTS: saved playlists are lists of library track ids, kept on the device.
async function saveList(tracks) {
  const ids = tracks.map(t => (sources.get(t.url) || {}).rec).filter(Boolean).map(r => r.id);
  if (!ids.length) { await notice("Save list", "There is nothing from the library in the playlist to save."); return null; }
  const name = (prompt("Save playlist as:") || "").trim();
  if (!name) return null;
  const lists = (await store.getSetting("lists")) || {};
  lists[name] = ids;
  await store.setSetting("lists", lists);
  const left = tracks.length - ids.length;
  await notice("Save list", `Saved "${name}" (${ids.length} tracks)${left ? `; ${left} not from the library were left out` : ""}.`);
  return null;
}

async function loadList() {
  const lists = (await store.getSetting("lists")) || {};
  const names = Object.keys(lists).sort((a, b) => a.localeCompare(b));
  if (!names.length) { await notice("Load list", "No saved playlists yet. Use Save List to keep the current one."); return null; }
  const name = await dialog("Load list", (body, done) => {
    const ul = document.createElement("ul");
    for (const n of names) {
      const li = document.createElement("li");
      const pick = document.createElement("button");
      pick.type = "button";
      pick.className = "pick";
      pick.textContent = `${n} (${lists[n].length})`;
      pick.onclick = () => done(n);
      const del = document.createElement("button");
      del.type = "button";
      del.className = "del";
      del.textContent = "Delete";
      del.onclick = async () => {
        if (!confirm(`Delete the saved playlist "${n}"?`)) return;
        delete lists[n];
        await store.setSetting("lists", lists);
        li.remove();
        if (!ul.children.length) done(null);
      };
      li.append(pick, del);
      ul.append(li);
    }
    body.append(ul);
  });
  if (!name) return null;
  const byId = new Map((await store.allTracks()).map(t => [t.id, t]));
  const records = lists[name].map(id => byId.get(id)).filter(Boolean);
  if (!records.length) { await notice("Load list", "None of that playlist's tracks are on this device any more."); return null; }
  return webampTracks(records);
}

// MISC > FILE INFO, for the selected track (or the current one).
function fileInfo() {
  const state = currentState();
  const id = state.playlist.selectedTracks[0] ?? state.playlist.currentTrack;
  if (id == null) return notice("File info", "Select a track in the playlist first.");
  const rec = recOf(state, id);
  const t = state.tracks[id] || {};
  if (!rec) return notice("File info", `${t.title || t.defaultName || "This track"} is not from the library, so only its address is known:\n${t.url || ""}`);
  const mmss = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
  const rows = [
    ["Title", rec.title], ["Artist", rec.artist], ["Album", rec.album], ["Album artist", rec.albumArtist],
    ["Track", rec.track && (rec.disc ? `${rec.track} (disc ${rec.disc})` : rec.track)], ["Year", rec.year],
    ["Length", mmss(rec.duration)],
    ["Format", `MP3, ${rec.bitrate} kbps, ${(rec.sampleRate / 1000).toFixed(1)} kHz, ${rec.channels === 1 ? "mono" : "stereo"}`],
    ["Gapless info", rec.gapless ? "Yes (LAME header)" : "No - a small gap is possible"],
    ["File", rec.fileName], ["Size", `${(rec.size / 1048576).toFixed(1)} MB`],
  ].filter(([, v]) => v != null && v !== "");
  return dialog("File info", body => {
    const dl = document.createElement("dl");
    for (const [k, v] of rows) {
      const dt = document.createElement("dt"), dd = document.createElement("dd");
      dt.textContent = k;
      dd.textContent = v;
      dl.append(dt, dd);
    }
    body.append(dl);
  });
}

// REM > REM MISC: Winamp's "remove dead files", plus repeated entries.
function removeMisc() {
  const state = currentState();
  const seenTracks = new Set(), ids = [];
  for (const id of state.playlist.trackOrder) {
    const url = urlOf(state, id);
    const dead = !url || (url.startsWith("blob:") && !sources.has(url));
    // The same library track queued twice has two different blob URLs.
    const rec = recOf(state, id), key = rec ? rec.id : url;
    if (dead || seenTracks.has(key)) ids.push(id);
    seenTracks.add(key);
  }
  if (ids.length) webamp.store.dispatch({ type: "REMOVE_TRACKS", ids });
  return notice("Remove misc", ids.length
    ? `Removed ${ids.length} dead or duplicate entr${ids.length === 1 ? "y" : "ies"}.`
    : "No dead or duplicate entries in the playlist.");
}

// REM > CROP: Webamp's own throws (it treats the selection as a Set), so do it here.
function crop() {
  const { trackOrder, selectedTracks } = currentState().playlist;
  if (!selectedTracks.length) return;
  const keep = new Set(selectedTracks);
  webamp.store.dispatch({ type: "REMOVE_TRACKS", ids: trackOrder.filter(id => !keep.has(id)) });
}

// Play on an empty playlist would open Webamp's own file picker; offer the library instead.
function playWhenEmpty() {
  if (currentState().playlist.trackOrder.length) return false; // not ours: let Webamp play
  openLibrary();
}

const OVERRIDES = [
  ["#playlist-add-menu .add-file", () => pickFiles("playlist")],
  ["#playlist-add-menu .add-dir", () => openLibrary(true)],
  ["#playlist-remove-menu .remove-misc", removeMisc],
  ["#playlist-misc-menu .file-info", fileInfo],
  ["#playlist-remove-menu .crop", crop],
  ["#eject, .playlist-eject-button", () => openLibrary()],
  ["#play, .playlist-play-button", playWhenEmpty],
];
document.addEventListener("click", e => {
  if (!(e.target instanceof Element) || e.target.closest("#dialog")) return;
  const hit = OVERRIDES.find(([selector]) => e.target.closest(selector));
  if (!hit || hit[1]() === false) return;
  e.stopPropagation(); // Webamp listens further down, on its own root
  e.preventDefault();
  // Webamp closes an open menu when it sees a click elsewhere; give it one.
  setTimeout(() => document.body.click(), 0);
}, true);

/* ---- startup ---- */

await refresh();
const last = await store.getSetting("lastAlbum").catch(() => null);
const resume = albums.find(a => a.key === last);
if (resume) await openAlbum(resume, "append");
else if (!albums.length) openLibrary();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

// For tests and poking around in the console.
window.amp = { webamp, media, store, importFiles, refresh, albums: () => albums };
