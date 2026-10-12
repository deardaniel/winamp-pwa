// Reads what the library needs from an MP3 without decoding it: ID3 tags
// (v2.2/2.3/2.4, falling back to v1) and the length from the Xing/LAME header.
// Works on a Blob, so it runs the same in the browser and in Node tests.

const SAMPLE_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
const BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

const bytes = async (blob, start, end) =>
  new Uint8Array(await blob.slice(start, Math.min(end, blob.size)).arrayBuffer());
const syncsafe = (b, o) => (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3];
const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const ascii = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));

const decode = (label, b, fatal = false) => new TextDecoder(label, { fatal }).decode(b);

// "ISO-8859-1" in a tag is a promise old taggers rarely kept: Japanese rips are
// usually Shift-JIS and some tools wrote UTF-8. Believe the bytes, not the label.
function decodeLegacy(b) {
  if (!b.some(c => c >= 0x80)) return decode("latin1", b);
  try { return decode("utf-8", b, true); } catch {}
  try {
    const s = decode("shift_jis", b, true);
    if (/[぀-ヿ]/.test(s) || (s.match(/[一-鿿]/g) || []).length >= 2) return s;
  } catch {}
  return decode("windows-1252", b);
}

function text(b) {
  if (!b.length) return "";
  const enc = b[0];
  let body = b.subarray(1);
  let s;
  if (enc === 1 || enc === 2) {
    let label = enc === 2 ? "utf-16be" : "utf-16le";
    if (body[0] === 0xfe && body[1] === 0xff) { label = "utf-16be"; body = body.subarray(2); }
    else if (body[0] === 0xff && body[1] === 0xfe) { label = "utf-16le"; body = body.subarray(2); }
    s = decode(label, body);
  } else if (enc === 3) s = decode("utf-8", body);
  else s = decodeLegacy(body);
  // v2.4 allows several null-separated values; the first is the one that matters here.
  return s.split("\0")[0].trim();
}

function picture(b, v22) {
  const enc = b[0];
  let o = 1, mime;
  if (v22) {
    const fmt = ascii(b, 1, 3).toUpperCase();
    mime = fmt === "PNG" ? "image/png" : "image/jpeg";
    o = 4;
  } else {
    const end = b.indexOf(0, 1);
    if (end < 0) return null;
    mime = ascii(b, 1, end - 1) || "image/jpeg";
    if (!mime.includes("/")) mime = "image/" + mime.toLowerCase();
    o = end + 1;
  }
  const type = b[o++];
  // Skip the description, whose terminator is two bytes wide in UTF-16.
  if (enc === 1 || enc === 2) { while (o + 1 < b.length && (b[o] || b[o + 1])) o += 2; o += 2; }
  else { while (o < b.length && b[o]) o++; o += 1; }
  if (o >= b.length) return null;
  return { mime, type, data: b.slice(o) };
}

const unsync = b => {
  const out = new Uint8Array(b.length);
  let n = 0;
  for (let i = 0; i < b.length; i++) {
    out[n++] = b[i];
    if (b[i] === 0xff && b[i + 1] === 0) i++;
  }
  return out.subarray(0, n);
};

const FIELDS = {
  TIT2: "title", TT2: "title", TPE1: "artist", TP1: "artist", TPE2: "albumArtist", TP2: "albumArtist",
  TALB: "album", TAL: "album", TRCK: "track", TRK: "track", TPOS: "disc", TPA: "disc",
  TYER: "year", TYE: "year", TDRC: "year", TDRL: "year", TCMP: "compilation", TCP: "compilation",
};

function parseId3v2(tag, major, flags) {
  const out = {};
  let b = tag;
  if (flags & 0x80 && major < 4) b = unsync(b);
  let o = 0;
  if (flags & 0x40) o = major === 4 ? syncsafe(b, 0) : u32(b, 0) + 4;
  const idLen = major === 2 ? 3 : 4, headLen = major === 2 ? 6 : 10;
  let pic = null;

  while (o + headLen <= b.length) {
    const id = ascii(b, o, idLen);
    if (!/^[A-Z0-9]+$/.test(id)) break; // padding
    let size;
    if (major === 2) size = (b[o + 3] << 16) | (b[o + 4] << 8) | b[o + 5];
    else if (major === 4) {
      size = syncsafe(b, o + 4);
      // Some writers (old iTunes) put a plain integer where v2.4 wants syncsafe.
      // If the syncsafe reading doesn't land on another frame but the plain one does, trust that.
      const plain = u32(b, o + 4);
      const lands = n => o + 10 + n === b.length || o + 10 + n + 4 > b.length || b[o + 10 + n] === 0 ||
        /^[A-Z0-9]{4}$/.test(ascii(b, o + 10 + n, 4));
      if (plain !== size && !lands(size) && lands(plain)) size = plain;
    } else size = u32(b, o + 4);
    const fflags = major === 2 ? 0 : b[o + 9];
    o += headLen;
    if (size <= 0 || o + size > b.length) break;
    let data = b.subarray(o, o + size);
    o += size;
    if (major === 4) {
      if (fflags & 0x01) data = data.subarray(4); // data length indicator
      if (fflags & 0x02 || flags & 0x80) data = unsync(data);
    }
    if (fflags & (major === 4 ? 0x0c : 0xc0)) continue; // compressed or encrypted

    if (id === "APIC" || id === "PIC") {
      const p = picture(data, major === 2);
      if (p && (!pic || (p.type === 3 && pic.type !== 3))) pic = p;
    } else if (FIELDS[id] && out[FIELDS[id]] === undefined) {
      const s = text(data);
      if (s) out[FIELDS[id]] = s;
    }
  }
  if (pic) out.picture = { mime: pic.mime, data: pic.data };
  return out;
}

function parseId3v1(b) {
  if (ascii(b, 0, 3) !== "TAG") return {};
  const field = (o, n) => {
    let end = o;
    while (end < o + n && b[end]) end++;
    return decodeLegacy(b.subarray(o, end)).trim();
  };
  const out = { title: field(3, 30), artist: field(33, 30), album: field(63, 30), year: field(93, 4) };
  if (b[125] === 0 && b[126]) out.track = String(b[126]);
  for (const k of Object.keys(out)) if (!out[k]) delete out[k];
  return out;
}

function frameHeader(b, o) {
  if (b[o] !== 0xff || (b[o + 1] & 0xe0) !== 0xe0) return null;
  const version = (b[o + 1] >> 3) & 3, layer = (b[o + 1] >> 1) & 3;
  const bitrateIdx = b[o + 2] >> 4, rateIdx = (b[o + 2] >> 2) & 3;
  if (version === 1 || layer !== 1 || bitrateIdx === 0 || bitrateIdx === 15 || rateIdx === 3) return null;
  const sampleRate = SAMPLE_RATES[version][rateIdx];
  const bitrate = (version === 3 ? BITRATES_V1 : BITRATES_V2)[bitrateIdx];
  const samplesPerFrame = version === 3 ? 1152 : 576;
  const padding = (b[o + 2] >> 1) & 1;
  const mono = b[o + 3] >> 6 === 3;
  const length = Math.floor(((samplesPerFrame / 8) * bitrate * 1000) / sampleRate) + padding;
  return { version, sampleRate, bitrate, samplesPerFrame, mono, length };
}

// Length and format from the first audio frame. With a Xing/LAME header the
// length is exact, including the encoder delay and padding gapless playback trims.
function parseAudio(b, audioBytes) {
  for (let o = 0; o + 4 < b.length; o++) {
    const h = frameHeader(b, o);
    if (!h) continue;
    // One sync word can be a coincidence; require the next frame to follow it.
    const next = o + h.length;
    if (next + 4 < b.length && !frameHeader(b, next)) continue;

    const info = { sampleRate: h.sampleRate, channels: h.mono ? 1 : 2, bitrate: h.bitrate };
    const x = o + 4 + (h.version === 3 ? (h.mono ? 17 : 32) : (h.mono ? 9 : 17));
    const magic = ascii(b, x, 4);
    if ((magic === "Xing" || magic === "Info") && b[x + 7] & 1) {
      const frames = u32(b, x + 8);
      let samples = frames * h.samplesPerFrame;
      if (b[x + 7] === 0x0f && x + 144 <= b.length && /^(LAME|Lavc|Lavf)/.test(ascii(b, x + 120, 4))) {
        const delay = (b[x + 141] << 4) | (b[x + 142] >> 4);
        const pad = ((b[x + 142] & 15) << 8) | b[x + 143];
        samples -= delay + pad;
        info.gapless = true;
      }
      info.duration = samples / h.sampleRate;
      if (info.duration > 0) info.bitrate = Math.round((audioBytes - o) * 8 / info.duration / 1000);
    } else {
      info.duration = ((audioBytes - o) * 8) / (h.bitrate * 1000);
    }
    return info;
  }
  return null;
}

const leadingInt = s => { const n = parseInt(s, 10); return Number.isFinite(n) ? n : null; };

/**
 * @param {Blob} blob an MP3 file
 * @returns title/artist/albumArtist/album (strings or null), track/disc/year
 *   (numbers or null), picture ({mime, data} or null), duration (seconds),
 *   sampleRate, channels, bitrate (kbps), gapless (true if LAME trim info exists)
 */
export async function readTags(blob) {
  let tags = {}, audioStart = 0;
  const head = await bytes(blob, 0, 10);
  if (ascii(head, 0, 3) === "ID3" && head[3] >= 2 && head[3] <= 4) {
    const size = syncsafe(head, 6);
    try { tags = parseId3v2(await bytes(blob, 10, 10 + size), head[3], head[5]); } catch {}
    audioStart = 10 + size + (head[5] & 0x10 ? 10 : 0);
  }
  let audioEnd = blob.size;
  if (blob.size > 128) {
    const v1 = parseId3v1(await bytes(blob, blob.size - 128, blob.size));
    if (Object.keys(v1).length || ascii(await bytes(blob, blob.size - 128, blob.size - 125), 0, 3) === "TAG") {
      audioEnd -= 128;
      tags = { ...v1, ...tags };
    }
  }
  const audio = parseAudio(await bytes(blob, audioStart, audioStart + 65536), audioEnd - audioStart) || {};

  return {
    title: tags.title || null,
    artist: tags.artist || null,
    albumArtist: tags.albumArtist || null,
    album: tags.album || null,
    track: tags.track ? leadingInt(tags.track) : null,
    disc: tags.disc ? leadingInt(tags.disc) : null,
    year: tags.year ? leadingInt(tags.year) : null,
    compilation: tags.compilation === "1",
    picture: tags.picture || null,
    duration: audio.duration || 0,
    sampleRate: audio.sampleRate || 44100,
    channels: audio.channels || 2,
    bitrate: audio.bitrate || 0,
    gapless: !!audio.gapless,
  };
}

const norm = s => (s || "").trim().toLowerCase();

/**
 * Groups track records into albums and orders the tracks, using tags only.
 * Tracks with no album tag fall into one "Unknown Album" per artist.
 */
export function groupAlbums(tracks) {
  const buckets = new Map();
  for (const t of tracks) {
    const album = t.album || "Unknown Album";
    // With an album artist the pairing is unambiguous. Without one, key on the
    // album alone so a compilation's many artists stay together...
    const owner = t.albumArtist || (t.album ? "" : t.artist || "");
    const key = norm(album) + "\u0000" + norm(owner);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(t);
  }

  const albums = [];
  for (const [key, list] of buckets) {
    // ...unless two artists both claim the same disc/track slot, which means
    // these are different albums that merely share a name ("Greatest Hits").
    const artists = new Set(list.map(t => norm(t.artist)));
    const slots = new Set(), clash = list.some(t => {
      if (t.track == null) return false;
      const slot = `${t.disc || 1}/${t.track}`;
      if (slots.has(slot)) return true;
      slots.add(slot);
      return false;
    });
    const splitByArtist = !list[0].albumArtist && artists.size > 1 && clash;
    const parts = splitByArtist
      ? [...artists].map(a => [key + "\u0000" + a, list.filter(t => norm(t.artist) === a)])
      : [[key, list]];

    for (const [k, ts] of parts) {
      ts.sort((a, b) =>
        (a.disc || 1) - (b.disc || 1) ||
        (a.track ?? 1e9) - (b.track ?? 1e9) ||
        (a.title || a.fileName || "").localeCompare(b.title || b.fileName || "", undefined, { numeric: true }));
      const names = new Set(ts.map(t => t.artist).filter(Boolean));
      albums.push({
        key: k,
        title: ts[0].album || "Unknown Album",
        artist: ts[0].albumArtist || (names.size === 1 ? [...names][0] : names.size ? "Various Artists" : "Unknown Artist"),
        year: ts.find(t => t.year)?.year || null,
        coverId: ts.find(t => t.coverId)?.coverId || null,
        duration: ts.reduce((s, t) => s + (t.duration || 0), 0),
        tracks: ts,
      });
    }
  }
  albums.sort((a, b) => a.artist.localeCompare(b.artist) || (a.year || 0) - (b.year || 0) || a.title.localeCompare(b.title));
  return albums;
}
