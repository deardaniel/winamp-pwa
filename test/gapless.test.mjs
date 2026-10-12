// Decodes three MP3s cut from one continuous sine at non-frame-aligned points
// and checks that the joined output lines up with the original, sample for sample.
// A player that ignores the LAME delay/padding fails this by ~2000 samples per join.
import { readFileSync } from "node:fs";
import { MPEGDecoder } from "mpg123-decoder";

const dir = new URL("./fixtures/", import.meta.url);
const cuts = [0, 150001, 333333, 12 * 44100];
const CHUNK = 16384; // feed in pieces, the way the player does

const raw = readFileSync(new URL("full.raw", dir));
const original = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);

const out = [];
let ok = true;
const check = (cond, msg) => { console.log(`${cond ? "ok  " : "FAIL"} ${msg}`); if (!cond) ok = false; };

for (let i = 0; i < 3; i++) {
  const data = readFileSync(new URL(`p${i + 1}.mp3`, dir));
  const decoder = new MPEGDecoder();
  await decoder.ready;
  let n = 0;
  for (let o = 0; o < data.length; o += CHUNK) {
    const { channelData, samplesDecoded } = decoder.decode(data.subarray(o, o + CHUNK));
    if (samplesDecoded) out.push(channelData[0].slice(0, samplesDecoded));
    n += samplesDecoded;
  }
  decoder.free();
  const want = cuts[i + 1] - cuts[i];
  // ffmpeg's LAME wrapper leaves a few samples of silence after the very last
  // track; that only pads the end of the album, so tolerate it there.
  check(i < 2 ? n === want : n >= want && n - want < 64, `p${i + 1}.mp3 decodes to ${n} samples (source ${want})`);
}

const pcm = new Float32Array(out.reduce((a, b) => a + b.length, 0));
let p = 0;
for (const b of out) { pcm.set(b, p); p += b.length; }

const maxErr = (a, b) => {
  let m = 0;
  for (let k = a; k < b; k++) m = Math.max(m, Math.abs(pcm[k] - original[k]));
  return m;
};
const mid = maxErr(50000, 100000);
check(mid < 0.01, `mid-track error ${mid.toFixed(4)}`);
for (const at of cuts.slice(1, 3)) {
  const e = maxErr(at - 2000, at + 2000);
  check(e < 0.03, `join @${at}: error ${e.toFixed(4)} (tone amplitude 0.088)`);
}

console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
