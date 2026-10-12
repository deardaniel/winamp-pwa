// Decodes MP3 files into the PCM stream the worklet plays.
//
// mpg123 trims each file's encoder delay and padding (from the LAME header), so
// decoding one file after another yields audio with no gap at the joins. This
// worker runs ahead of playback by AHEAD_SECONDS and walks its own queue of
// upcoming tracks, so the join needs nothing from the main thread - which iOS
// may well have throttled by then if the phone is locked.

importScripts("vendor/mpg123-decoder.min.js");
const { MPEGDecoder } = self["mpg123-decoder"];

const AHEAD_SECONDS = 30;
const READ_BYTES = 32768;

let port = null;       // to the worklet
let rate = 44100;      // the AudioContext's rate
let decoder = null;

let gen = 0;
let pending = null;    // track to start the generation with
let queue = [];        // tracks to follow it, in order
let current = null;    // track being decoded
let seq = 0;
let sent = 0;          // frames posted this generation
let consumed = 0;      // frames the worklet has played
let finished = true;
let pumping = false;

self.onmessage = ({ data: m }) => {
  if (m.cmd === "init") {
    port = m.port;
    rate = m.rate;
    port.onmessage = ({ data }) => {
      if (data.gen !== gen) return;
      consumed = data.consumed;
      pump();
    };
  } else if (m.cmd === "start") {
    gen = m.gen;
    pending = { key: m.key, file: m.file, at: m.at || 0 };
    queue = m.queue || [];
    current = null;
    seq = sent = consumed = 0;
    finished = false;
    pump();
  } else if (m.cmd === "queue") {
    if (m.gen !== gen) return;
    // m.queue is what follows the track now *playing* (seq m.after), but decoding
    // runs ahead: skip the ones already decoded or they would play twice.
    queue = m.queue.slice(Math.max(0, seq - 1 - m.after));
    // Webamp adds an album's tracks one at a time, so a short first track can be
    // fully decoded before the second is even known. Pick the stream back up;
    // the worklet discards the end marker if playback hasn't reached it yet.
    if (finished && queue.length) {
      finished = false;
      pump();
    }
  } else if (m.cmd === "halt") {
    gen = m.gen;
    pending = current = null;
    queue = [];
    finished = true;
  }
};

async function open(track) {
  if (decoder) await decoder.reset();
  else {
    decoder = new MPEGDecoder();
    await decoder.ready;
  }
  // Queued tracks carry no start position; only the first of a generation can be a seek.
  return { ...track, at: track.at || 0, offset: 0, first: true, skip: -1, base: 0, rs: null };
}

// Linear resampling for the odd file that doesn't match the context's rate.
// State carries across chunks so there's no seam at chunk boundaries.
function resample(t, chans, n, srcRate) {
  const step = srcRate / rate;
  const rs = t.rs || (t.rs = { pos: 0, prev: chans.map(() => 0) });
  const count = rs.pos < n - 1 ? Math.ceil((n - 1 - rs.pos) / step) : 0;
  const out = chans.map((src, ch) => {
    const dst = new Float32Array(count);
    let p = rs.pos;
    for (let k = 0; k < count; k++, p += step) {
      const i = Math.floor(p), f = p - i;
      const a = i < 0 ? rs.prev[ch] : src[i];
      dst[k] = a + (src[i + 1] - a) * f;
    }
    return dst;
  });
  rs.pos += count * step - n;
  if (n) rs.prev = chans.map(src => src[n - 1]);
  return out;
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (!finished && sent - consumed < AHEAD_SECONDS * rate) {
      const g = gen;
      if (!current) {
        const next = pending || queue.shift();
        pending = null;
        if (!next) {
          finished = true;
          port.postMessage({ gen: g, end: true });
          break;
        }
        next.seq = seq++; // before the await, so a queue update sees it as taken
        const opened = await open(next);
        if (g !== gen) continue;
        current = opened;
      }
      const t = current;
      const buf = new Uint8Array(await t.file.slice(t.offset, t.offset + READ_BYTES).arrayBuffer());
      if (g !== gen) continue;
      t.offset += buf.length;
      const eof = t.offset >= t.file.size || buf.length === 0;

      const { channelData, samplesDecoded, sampleRate } = decoder.decode(buf);
      let n = samplesDecoded;
      if (n > 0) {
        let chans = [channelData[0], channelData[1] || channelData[0]];
        // Seeking decodes from the top and discards: exact for VBR, and it keeps
        // the decoder's gapless bookkeeping intact. It's fast enough not to matter.
        if (t.skip < 0) {
          t.skip = Math.round(t.at * sampleRate);
          t.base = Math.round(t.at * rate);
        }
        const drop = Math.min(t.skip, n);
        t.skip -= drop;
        chans = chans.map(c => c.subarray(drop, n));
        n -= drop;
        if (n > 0 && sampleRate !== rate) {
          chans = resample(t, chans, n, sampleRate);
          n = chans[0].length;
        }
        if (n > 0) {
          const l = new Float32Array(chans[0]), r = new Float32Array(chans[1]);
          port.postMessage(
            { gen: g, seq: t.seq, key: t.key, start: t.first, base: t.base, l, r },
            [l.buffer, r.buffer]);
          t.first = false;
          t.base += n;
          sent += n;
        }
      }
      if (eof) current = null;
    }
  } catch (err) {
    self.postMessage({ type: "error", gen, message: String(err && err.message || err) });
    current = null;
  } finally {
    pumping = false;
  }
}
