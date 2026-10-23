import Webamp from "./vendor/webamp.bundle.min.mjs";
import { GaplessMedia, sources, setUpcoming, outputMode } from "./media.js";
import { readTags, groupAlbums } from "./tags.js";
import * as store from "./store.js";
import { fit } from "./fit.js";

const $ = id => document.getElementById(id);

/* ---- Webamp, scaled to fill the screen ---- */

// fit.js decides the zoom and where each window goes; this applies it. It runs
// again on every resize, because an iPhone Duo folds and unfolds without
// reloading the page.
function measure() {
  const safe = getComputedStyle($("safe"));
  const inset = { top: parseFloat(safe.paddingTop) || 0, right: parseFloat(safe.paddingRight) || 0,
                  left: parseFloat(safe.paddingLeft) || 0 };
  return fit(window.innerWidth, window.innerHeight, inset, $("bar").getBoundingClientRect().height);
}

// Webamp keeps its windows inside the node it's given, measured in unzoomed
// pixels, and shoves any that stick out. Sized to the whole screen in skin
// pixels, that box never makes it move one.
function placeStage({ scale, stage }) {
  document.documentElement.style.setProperty("--scale", scale);
  $("stage").style.width = `${stage.width}px`;
  $("stage").style.height = `${stage.height}px`;
}

const first = measure();
placeStage(first);
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
    main: { position: { top: first.positions.main.y, left: first.positions.main.x } },
    equalizer: { position: { top: first.positions.equalizer.y, left: first.positions.equalizer.x } },
    playlist: { position: { top: first.positions.playlist.y, left: first.positions.playlist.x },
                size: { extraHeight: first.rows, extraWidth: 0 } },
  },
});
const media = webamp.media;

await webamp.renderWhenReady($("stage"));
const root = document.getElementById("webamp");

/* ---- skin windows ---- */

// Dialogs are Webamp "generic" windows: the markup its own extra windows use,
// placed inside its root. So whichever skin is loaded draws their frame and
// title lettering, at the same zoom as the player.
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
genWindow($("dialog").firstElementChild, "dialog");
root.append($("dialog"));

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

// Text inside those windows takes the playlist editor's colours from the skin.
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
// space at the bottom. Its side borders tile, so pin its height to the exact
// remainder instead. A stylesheet rule, because Webamp rewrites the inline one.
const exactHeight = document.head.appendChild(document.createElement("style"));
function refit() {
  const now = measure();
  placeStage(now);
  root.style.zoom = now.scale;
  const { windows } = webamp.store.getState();
  if (windows.genWindows.playlist.size[1] !== now.rows)
    webamp.store.dispatch({ type: "WINDOW_SIZE_CHANGED", windowId: "playlist", size: [0, now.rows] });
  // Put the windows back where they belong, after Webamp's own resize handler
  // has had its go (it runs first and may have moved them).
  webamp.store.dispatch({ type: "UPDATE_WINDOW_POSITIONS", positions: now.positions, absolute: true });
  exactHeight.textContent = `#webamp #playlist-window { height: ${now.playlistH}px !important; }`;
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
  if (orderChanged) { sweep(); playlistChanged(); }
  // Tracks added to an idle player have no "current" one, and Play then does
  // nothing at all. Cue the first so Play has something to start.
  // Deferred, so a caller that adds tracks and then picks one itself gets in first.
  setTimeout(() => {
    const now = webamp.store.getState();
    if (now.media.status === "STOPPED" && now.playlist.currentTrack == null && now.playlist.trackOrder.length)
      webamp.store.dispatch({ type: "BUFFER_TRACK", id: now.playlist.trackOrder[0] });
  }, 0);
});

// Webamp labels every track that comes with metaData as 192 kbps / 44 kHz
// stereo. Correct it once it has. The readout comes from the track, and only
// SET_MEDIA_TAGS writes that (SET_MEDIA sets just the length), so the tags
// already there go back in unchanged.
media.on("fileLoaded", () => {
  const info = media.info();
  const state = webamp.store.getState();
  const id = state.playlist.currentTrack;
  const track = id != null && state.tracks[id];
  if (!info || !track) return;
  webamp.store.dispatch({ type: "SET_MEDIA", id, length: info.duration });
  if (!info.bitrate) return;
  webamp.store.dispatch({
    type: "SET_MEDIA_TAGS", id,
    title: track.title, artist: track.artist, album: track.album, albumArtUrl: track.albumArtUrl,
    bitrate: info.bitrate * 1000,
    sampleRate: info.sampleRate || 44100,
    numberOfChannels: info.channels || 2,
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

/* ---- the cache ---- */

// There is no library. Files picked in the Files app are copied into the app's
// own storage, because iOS won't let a web app reopen a picked file later, and
// a copy lives exactly as long as something refers to it: the playlist, or a
// saved list. Remove it from both and it is deleted from the phone.

const coverUrls = new Map();
async function coverUrl(id) {
  if (!id) return null;
  if (!coverUrls.has(id)) {
    const c = await store.getCover(id);
    coverUrls.set(id, c ? URL.createObjectURL(new Blob([c.data], { type: c.mime })) : null);
  }
  return coverUrls.get(id);
}

// Builds Webamp tracks for cached files. Each gets a blob URL onto its file in
// storage; `sources` is how the audio engine (and the buttons below) get from
// that URL back to the file and its record.
const building = new Set();
async function webampTracks(records) {
  const out = [];
  for (const t of records) {
    let file;
    // A record whose file has gone (storage cleared underneath us) is just skipped.
    try { file = await store.audioFile(t.id); } catch { continue; }
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

const currentState = () => webamp.store.getState();
const recOf = (state, id) => (sources.get(urlOf(state, id)) || {}).rec;

// Blob URLs pin their file open, so drop the ones no playlist entry uses any more.
function sweep() {
  const state = currentState();
  const live = new Set(state.playlist.trackOrder.map(id => urlOf(state, id)));
  for (const [url, entry] of sources)
    if (entry.rec && !live.has(url) && !building.has(url)) { sources.delete(url); URL.revokeObjectURL(url); }
}

const savedLists = async () => (await store.getSetting("lists")) || {};

// The playlist as it is stored: cached files by id, web addresses as themselves.
function playlistEntries() {
  const state = currentState();
  return state.playlist.trackOrder.map(id => {
    const rec = recOf(state, id), t = state.tracks[id] || {};
    return rec ? { id: rec.id } : { url: t.url, name: t.defaultName || t.title || null };
  }).filter(e => e.id || (e.url && !e.url.startsWith("blob:")));
}

let restored = false;       // nothing is saved or deleted until the last session's playlist is back
let importing = 0;
const adding = new Set();   // picked files on their way into the playlist

async function savePlaylist() {
  if (!restored) return;
  const { trackOrder, currentTrack } = currentState().playlist;
  await store.setSetting("playlist", { entries: playlistEntries(), current: Math.max(0, trackOrder.indexOf(currentTrack)) });
}

// Deletes every cached file that neither the playlist nor a saved list refers to.
async function collect() {
  if (!restored || importing) return;
  const keep = new Set(adding);
  for (const e of playlistEntries()) if (e.id) keep.add(e.id);
  for (const ids of Object.values(await savedLists())) for (const id of ids) keep.add(id);
  const covers = new Set();
  for (const t of await store.allTracks()) {
    if (keep.has(t.id)) { if (t.coverId) covers.add(t.coverId); continue; }
    await store.deleteTrack(t.id);
    await store.removeAudio(t.id);
  }
  for (const id of await store.coverKeys())
    if (!covers.has(id)) { await store.deleteCover(id); coverUrls.delete(id); }
}

// Loading a list empties the playlist a moment before refilling it, so wait
// for things to settle before deciding what is no longer wanted.
let saveTimer, collectTimer;
function playlistChanged() {
  clearTimeout(saveTimer);
  clearTimeout(collectTimer);
  saveTimer = setTimeout(() => savePlaylist().catch(() => {}), 300);
  collectTimer = setTimeout(() => collect().catch(err => console.warn("collect:", err)), 3000);
}
webamp.onTrackDidChange(() => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => savePlaylist().catch(() => {}), 300);
});

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

// Copies picked files into the cache and returns their records, plus how many
// could not be read. A file already cached (same name and size) is reused.
async function importFiles(files, progress = () => {}) {
  const existing = await store.allTracks();
  const byFile = new Map(existing.map(t => [`${t.fileName}/${t.size}`, t]));
  const covers = new Set(existing.map(t => t.coverId).filter(Boolean));
  const picked = [];
  let failed = 0;
  await store.persist();
  importing++;
  try {
    for (const [i, file] of files.entries()) {
      progress(`Reading ${i + 1} of ${files.length}\n${file.name}`);
      const key = `${file.name}/${file.size}`;
      let rec = byFile.get(key);
      if (!rec) {
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
          rec = { id, fileName: file.name, size: file.size, coverId, added: Date.now(), ...rest };
          await store.putTrack(rec);
          byFile.set(key, rec);
        } catch (err) {
          console.warn("import failed:", file.name, err);
          failed++;
          continue;
        }
      }
      adding.add(rec.id);
      if (!picked.includes(rec)) picked.push(rec);
    }
  } finally { importing--; }
  return { picked, failed };
}

// Picked files go on the end of the playlist, in tag order (album, disc, track)
// rather than whatever order the picker returned them in.
async function addFiles(files, progress) {
  const { picked, failed } = await importFiles(files, progress);
  if (picked.length) {
    const ordered = groupAlbums(picked).flatMap(a => a.tracks);
    webamp.appendTracks(await webampTracks(ordered));
    setTimeout(() => { for (const t of ordered) adding.delete(t.id); }, 5000);
  }
  return { added: picked.length, failed };
}

/* ---- dialogs ---- */

function dialog(title, build) {
  return new Promise(resolve => {
    const box = $("dialog"), body = $("dialog-body");
    setTitle($("dialog-title"), title);
    body.textContent = "";
    const done = value => { box.hidden = true; resolve(value); };
    build(body, done);
    $("close-dialog").onclick = () => done(null);
    box.hidden = false;
  });
}
const notice = (title, text) => dialog(title, body => {
  const p = document.createElement("p");
  p.textContent = text;
  body.append(p);
});
const button = (label, onclick) => {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.onclick = onclick;
  return b;
};

/* ---- files in ---- */

// Every "open" in the player leads here: the Files app, through the picker.
const pickFiles = () => $("pick-mp3").click();
$("pick-mp3").onchange = async e => {
  const files = [...e.target.files];
  e.target.value = "";
  if (!files.length) return;
  let line, close;
  dialog("Add files", (body, done) => {
    line = document.createElement("p");
    body.append(line);
    close = done;
  });
  const { added, failed } = await addFiles(files, text => { line.textContent = text; });
  if (failed) line.textContent = `Added ${added}. ${failed} could not be read as MP3.`;
  else close();
};

async function pickSkin(file) {
  const data = await file.arrayBuffer();
  // A .wsz is a zip; anything else would leave Webamp half-skinned.
  if (new Uint8Array(data, 0, 2).join() !== "80,75") return notice("Load skin", `${file.name} is not a Winamp skin (.wsz).`);
  await store.setSetting("skin", data);
  webamp.setSkinFromUrl(URL.createObjectURL(new Blob([data])));
  $("dialog").hidden = true;
}
$("pick-skin").onchange = e => {
  const file = e.target.files[0];
  e.target.value = "";
  if (file) pickSkin(file);
};
async function baseSkin() {
  await store.deleteSetting("skin");
  location.reload();
}

/* ---- playlist buttons ---- */

// Webamp ships several of the playlist editor's buttons as "Not supported", and
// its own file buttons open a picker whose files would never reach the cache.
// Those taps are caught here, before Webamp's handlers see them.

// ADD URL
async function addUrl() {
  const url = (prompt("Address of an MP3 to add:") || "").trim();
  if (!url) return null;
  try { new URL(url); } catch { await notice("Add URL", "That is not a valid address."); return null; }
  const name = decodeURIComponent(new URL(url).pathname.split("/").pop() || "") || url;
  return [{ url, defaultName: name }];
}

// LIST OPTS. Winamp saved a list as an .m3u pointing at files on disk; here a
// saved list points at cached copies, and is what keeps them on the phone once
// they leave the playlist.
async function saveList(tracks) {
  const ids = tracks.map(t => (sources.get(t.url) || {}).rec).filter(Boolean).map(r => r.id);
  if (!ids.length) { await notice("Save list", "There are no files in the playlist to save."); return null; }
  const name = (prompt("Save playlist as:") || "").trim();
  if (!name) return null;
  const lists = await savedLists();
  lists[name] = ids;
  await store.setSetting("lists", lists);
  const left = tracks.length - ids.length;
  await notice("Save list", `Saved "${name}" (${ids.length} tracks)${left ? `; ${left} web addresses were left out` : ""}.`);
  return null;
}

async function loadList() {
  const lists = await savedLists();
  const names = Object.keys(lists).sort((a, b) => a.localeCompare(b));
  if (!names.length) { await notice("Load list", "No saved lists yet. Save List keeps the current playlist, and its files, for later."); return null; }
  const name = await dialog("Load list", (body, done) => {
    const ul = document.createElement("ul");
    for (const n of names) {
      const li = document.createElement("li");
      const pick = button(`${n} (${lists[n].length})`, () => done(n));
      pick.className = "pick";
      const del = button("Delete", async () => {
        if (!confirm(`Delete the saved list "${n}"? Its files are removed from this device unless they are in the playlist or another list.`)) return;
        delete lists[n];
        await store.setSetting("lists", lists);
        li.remove();
        playlistChanged();
        if (!ul.children.length) done(null);
      });
      li.append(pick, del);
      ul.append(li);
    }
    body.append(ul);
  });
  if (!name) return null;
  const byId = new Map((await store.allTracks()).map(t => [t.id, t]));
  const records = lists[name].map(id => byId.get(id)).filter(Boolean);
  if (!records.length) { await notice("Load list", "That list's files are no longer on this device."); return null; }
  return webampTracks(records);
}

// MISC > FILE INFO, for the selected track (or the current one).
function fileInfo() {
  const state = currentState();
  const id = state.playlist.selectedTracks[0] ?? state.playlist.currentTrack;
  if (id == null) return notice("File info", "Select a track in the playlist first.");
  const rec = recOf(state, id);
  const t = state.tracks[id] || {};
  if (!rec) return notice("File info", `${t.title || t.defaultName || "This track"} is a web address, not a file on this device:\n${t.url || ""}`);
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

// MISC > MISC OPTS: the settings that have nowhere else to live.
async function options() {
  const tracks = await store.allTracks();
  const mb = tracks.reduce((n, t) => n + t.size, 0) / 1048576;
  const lists = Object.keys(await savedLists()).length;
  return dialog("Options", body => {
    const p = document.createElement("p");
    p.textContent = `${tracks.length} file${tracks.length === 1 ? "" : "s"} on this device, ` +
      `${mb >= 1000 ? (mb / 1024).toFixed(1) + " GB" : Math.round(mb) + " MB"}. ${lists} saved list${lists === 1 ? "" : "s"}.`;
    const row = document.createElement("div");
    row.className = "actions";
    row.append(
      button("Load skin", () => $("pick-skin").click()),
      button("Default skin", baseSkin),
      // Two ways of getting sound out; kept switchable to compare lock-screen behaviour on a phone.
      button(`Audio: ${outputMode() === "element" ? "background" : "direct"}`, () => {
        localStorage.setItem("gapless.out", outputMode() === "element" ? "direct" : "element");
        location.reload();
      }));
    body.append(p, row);
  });
}

// REM > REM MISC: Winamp's "remove dead files", plus repeated entries.
function removeMisc() {
  const state = currentState();
  const seenTracks = new Set(), ids = [];
  for (const id of state.playlist.trackOrder) {
    const url = urlOf(state, id);
    const dead = !url || (url.startsWith("blob:") && !sources.has(url));
    // The same file queued twice has two different blob URLs.
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

// Play with nothing loaded opened a file dialog in Winamp too.
function playWhenEmpty() {
  if (currentState().playlist.trackOrder.length) return false; // not ours: let Webamp play
  pickFiles();
}

const OVERRIDES = [
  ["#playlist-add-menu .add-file", pickFiles],
  ["#playlist-add-menu .add-dir", pickFiles], // iOS has no folder picker; Select All in Files does the job
  ["#playlist-remove-menu .remove-misc", removeMisc],
  ["#playlist-remove-menu .crop", crop],
  ["#playlist-misc-menu .file-info", fileInfo],
  ["#playlist-misc-menu .misc-options", options],
  ["#eject, .playlist-eject-button", pickFiles],
  ["#play, .playlist-play-button", playWhenEmpty],
];
// The same for the entries of Webamp's main menu that open its own pickers.
const MENU_OVERRIDES = {
  "File...": pickFiles,
  "Load Skin...": () => $("pick-skin").click(),
  "<Base Skin>": baseSkin,
};
document.addEventListener("click", e => {
  if (!(e.target instanceof Element) || e.target.closest("#dialog")) return;
  const item = e.target.closest("#webamp-context-menu li");
  const hit = OVERRIDES.find(([selector]) => e.target.closest(selector)) ||
    (item && MENU_OVERRIDES[item.textContent.trim()] && [null, MENU_OVERRIDES[item.textContent.trim()]]);
  if (!hit || hit[1]() === false) return;
  e.stopPropagation(); // Webamp listens further down, on its own root
  e.preventDefault();
  // Webamp closes an open menu when it sees a click elsewhere; give it one.
  setTimeout(() => document.body.click(), 0);
}, true);

/* ---- menus stay on screen ---- */

// Webamp opens a menu down and to the right of the tap, and its submenus to the
// right of their item. On a phone the EQ's PRESETS button is at the right edge,
// so Load's list of presets opened off screen. Nudge each one back in.
const EDGE = 4;
function nudge(el) {
  const r = el.getBoundingClientRect();
  let dx = 0, dy = 0;
  if (r.right > innerWidth - EDGE) dx = innerWidth - EDGE - r.right;
  if (r.left + dx < EDGE) dx = EDGE - r.left;
  if (r.bottom > innerHeight - EDGE) dy = innerHeight - EDGE - r.bottom;
  if (r.top + dy < EDGE) dy = EDGE - r.top;
  return { r, dx, dy };
}

function placeSubmenu(ul) {
  Object.assign(ul.style, { left: "", right: "", top: "", marginLeft: "", marginRight: "" });
  const { r, dy } = nudge(ul);
  if (r.right > innerWidth - EDGE) {
    // Open to the left of the item instead, mirroring Webamp's overlap.
    Object.assign(ul.style, { left: "auto", right: "100%", marginLeft: "0", marginRight: "-3px" });
  }
  if (dy) ul.style.top = `${dy}px`;
}

new MutationObserver(records => {
  for (const rec of records) for (const node of rec.addedNodes) {
    if (!(node instanceof Element)) continue;
    const menu = node.matches(".context-menu") ? node : node.querySelector?.("#webamp-context-menu .context-menu");
    if (!menu) continue;
    menu.style.transform = "";
    const { dx, dy } = nudge(menu);
    if (dx || dy) menu.style.transform = `translate(${dx}px, ${dy}px)`;
  }
}).observe(document.body, { childList: true, subtree: true });

for (const type of ["pointerover", "mouseover"]) {
  document.addEventListener(type, e => {
    const li = e.target instanceof Element && e.target.closest("#webamp-context-menu li.parent");
    const ul = li && li.querySelector(":scope > ul");
    if (ul) requestAnimationFrame(() => placeSubmenu(ul));
  }, true);
}

/* ---- startup ---- */

let last = await store.getSetting("playlist").catch(() => null);
if (!last) {
  // First run since the library was removed: nothing refers to its albums yet,
  // so save each one as a list rather than let collect() delete them.
  const albums = groupAlbums(await store.allTracks());
  if (albums.length) {
    const lists = await savedLists();
    for (const a of albums) lists[`${a.artist} - ${a.title}`] ||= a.tracks.map(t => t.id);
    await store.setSetting("lists", lists);
    const key = await store.getSetting("lastAlbum").catch(() => null);
    const resume = albums.find(a => a.key === key);
    if (resume) last = { entries: resume.tracks.map(t => ({ id: t.id })), current: 0 };
  }
}
if (last && last.entries.length) {
  const byId = new Map((await store.allTracks()).map(t => [t.id, t]));
  const tracks = [];
  for (const e of last.entries) {
    if (e.id && byId.has(e.id)) tracks.push(...await webampTracks([byId.get(e.id)]));
    else if (e.url) tracks.push({ url: e.url, ...(e.name ? { defaultName: e.name } : {}) });
  }
  webamp.appendTracks(tracks);
  const order = currentState().playlist.trackOrder;
  if (order.length) webamp.store.dispatch({ type: "BUFFER_TRACK", id: order[Math.min(last.current || 0, order.length - 1)] });
}
restored = true;
playlistChanged();

if (!currentState().playlist.trackOrder.length)
  notice("Gapless Amp", Object.keys(await savedLists()).length
    ? "The playlist is empty. LIST OPTS > LOAD LIST brings back a saved list; ADD or the eject button picks MP3s from Files."
    : "Tap ADD or the eject button to pick MP3s from Files. They stay on this device while they are in the playlist or in a saved list.");

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

// For tests and poking around in the console.
window.amp = { webamp, media, store, addFiles, collect, playlistEntries };

// What the feedback form (kichi feedback.js) sends along with a screenshot.
window.kichiFeedback = {
  state() {
    const s = currentState();
    const id = s.playlist.currentTrack;
    const t = id != null ? s.tracks[id] || {} : null;
    const rec = id != null ? recOf(s, id) : null;
    const dialog = document.getElementById("dialog");
    return {
      status: s.media.status,
      elapsed: Math.round(media.timeElapsed() * 10) / 10,
      track: t && { title: t.title, artist: t.artist, album: t.album, kbps: t.kbps, khz: t.khz, duration: t.duration,
        file: rec && { name: rec.fileName, bitrate: rec.bitrate, sampleRate: rec.sampleRate, gapless: rec.gapless } },
      playlist: s.playlist.trackOrder.length,
      selected: s.playlist.selectedTracks.length,
      output: outputMode(),
      dialog: dialog && !dialog.hidden && dialog.offsetParent ? dialog.innerText.slice(0, 500) : null,
    };
  },
};
