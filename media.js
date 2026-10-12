// Webamp's audio backend, replaced. Webamp's own plays each track through an
// <audio> element and loads the next one when the last ends, which always
// leaves a gap. This one hands Webamp the same interface (IMedia) but plays a
// single PCM stream that the decode worker keeps extending with the next track.
//
// The awkward part is that Webamp still believes it changes tracks itself. So
// when playback crosses into the next track we announce "ended"; Webamp then
// asks us to load the track that is in fact already playing, and we just nod.

import { readTags } from "./tags.js";

const BANDS = [60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000];
const RATE = 44100;

/** url -> { file: Blob, duration, sampleRate, channels, bitrate }. The app fills this in. */
export const sources = new Map();

let upcoming = () => [];
/** The app supplies the URLs that follow the current track, in play order. */
export function setUpcoming(fn) { upcoming = fn; }

// "element" routes audio through an <audio> tag, which is what lets iOS keep
// playing with the screen locked. "direct" is plain Web Audio, kept as a
// fallback to compare against on a real phone.
export const outputMode = () => {
  try { return localStorage.getItem("gapless.out") === "direct" ? "direct" : "element"; }
  catch { return "element"; }
};

export class GaplessMedia {
  constructor() {
    this._listeners = {};
    this._gen = 0;
    this._seq = 0;
    this._frame = 0;
    this._url = null;
    this._entry = null;
    this._status = "STOPPED";
    this._adopting = null;
    this._loadToken = 0;

    // Tells iOS this is a music player: ignore the mute switch, keep going when locked.
    try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch {}

    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = this._ctx = new AC({ sampleRate: RATE, latencyHint: "playback" });

    //  worklet -> input -+-> preamp -> [10 EQ bands] -+-> balance -+-> gain -> out
    //                    +------- EQ bypass ----------+            +-> analyser
    this._input = ctx.createGain();
    this._preamp = ctx.createGain();
    this._balance = ctx.createStereoPanner();
    this._gain = ctx.createGain();
    this._analyser = ctx.createAnalyser();
    this._analyser.fftSize = 2048;
    this._analyser.smoothingTimeConstant = 0;

    this._bands = {};
    let tail = this._preamp;
    BANDS.forEach((hz, i) => {
      const f = ctx.createBiquadFilter();
      f.type = i === 0 ? "lowshelf" : i === BANDS.length - 1 ? "highshelf" : "peaking";
      f.frequency.value = hz;
      f.gain.value = 0;
      tail.connect(f);
      tail = this._bands[hz] = f;
    });
    this._eqOut = tail;
    this._eqOut.connect(this._balance);
    this._input.connect(this._preamp);
    this._balance.connect(this._gain);
    this._balance.connect(this._analyser);

    if (outputMode() === "element") {
      const dest = ctx.createMediaStreamDestination();
      this._gain.connect(dest);
      this._el = new Audio();
      this._el.srcObject = dest.stream;
      this._el.setAttribute("playsinline", "");
    } else {
      this._gain.connect(ctx.destination);
    }

    this._ready = this._init();
  }

  async _init() {
    const ctx = this._ctx;
    await ctx.audioWorklet.addModule("player-worklet.js");
    this._node = new AudioWorkletNode(ctx, "gapless-player", {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
    });
    this._node.connect(this._input);
    this._node.port.onmessage = e => this._onWorklet(e.data);

    this._worker = new Worker("decode-worker.js");
    this._worker.onmessage = e => { if (e.data.type === "error") console.warn("decode:", e.data.message); };
    const { port1, port2 } = new MessageChannel();
    this._node.port.postMessage({ cmd: "port", port: port1 }, [port1]);
    this._worker.postMessage({ cmd: "init", port: port2, rate: ctx.sampleRate }, [port2]);
  }

  /* ---- plumbing ---- */

  on(event, cb) { (this._listeners[event] ||= []).push(cb); }
  _emit(event) { for (const cb of this._listeners[event] || []) cb(); }

  // Must run inside the tap that triggered it, before any await, or iOS refuses.
  _wake() {
    if (this._ctx.state !== "running") this._ctx.resume().catch(() => {});
    if (this._el && this._el.paused) this._el.play().catch(() => {});
  }
  /** For taps that reach play() only after an await (opening an album from storage). */
  unlock() { this._wake(); }
  _sleep() {
    if (this._el) this._el.pause();
    this._ctx.suspend().catch(() => {});
  }

  _queue() {
    const out = [];
    for (const url of upcoming()) {
      const entry = sources.get(url);
      if (!entry) break; // something we'd have to fetch first: let it start the hard way
      out.push({ key: url, file: entry.file });
    }
    return out;
  }

  /** Call when the playlist, shuffle or repeat changes, so the worker joins the right track next. */
  refreshQueue() {
    if (this._worker && this._status !== "STOPPED")
      this._worker.postMessage({ cmd: "queue", gen: this._gen, queue: this._queue() });
  }

  _start(at, playing) {
    this._gen++;
    this._seq = 0;
    this._frame = Math.round(at * this._ctx.sampleRate);
    this._node.port.postMessage({ cmd: "flush", gen: this._gen, playing });
    this._worker.postMessage({
      cmd: "start", gen: this._gen, key: this._url, file: this._entry.file, at, queue: this._queue(),
    });
  }

  _halt() {
    this._gen++;
    this._frame = 0;
    this._status = "STOPPED";
    if (this._node) {
      this._node.port.postMessage({ cmd: "flush", gen: this._gen, playing: false });
      this._worker.postMessage({ cmd: "halt", gen: this._gen });
    }
    this._sleep();
    this._emit("timeupdate");
  }

  _onWorklet(m) {
    if (m.gen !== this._gen) return;
    if (m.type === "pos") {
      if (m.seq !== this._seq) return;
      this._frame = m.frame;
      this._emit("timeupdate");
    } else if (m.type === "track") {
      if (m.seq <= this._seq) return; // the track we started with, not a join
      // Playback has already rolled into the next track. Tell Webamp the old
      // one ended; it will call loadFromUrl() with what should be this very track.
      this._seq = m.seq;
      this._frame = 0;
      this._adopting = m.key;
      this._emit("ended");
      if (this._adopting) {
        // Webamp didn't follow (the playlist changed under us, or it had nothing next).
        this._adopting = null;
        this._halt();
      }
    } else if (m.type === "ended") {
      this._status = "STOPPED";
      this._frame = 0;
      this._sleep();
      this._emit("ended");
    }
  }

  async _resolve(url) {
    let entry = sources.get(url);
    if (!entry) {
      // Not from the library (Webamp's own file dialog, or a remote URL).
      const file = await (await fetch(url)).blob();
      const t = await readTags(file);
      entry = { file, duration: t.duration, sampleRate: t.sampleRate, channels: t.channels, bitrate: t.bitrate };
      sources.set(url, entry);
    }
    return entry;
  }

  /* ---- IMedia ---- */

  async loadFromUrl(url, autoPlay) {
    if (autoPlay) this._wake();
    const token = ++this._loadToken;

    if (autoPlay && this._adopting === url) {
      this._adopting = null;
      this._url = url;
      this._entry = sources.get(url);
      this._emit("fileLoaded");
      this.refreshQueue();
      return;
    }
    this._adopting = null;

    this._emit("waiting");
    try {
      await this._ready;
      const entry = await this._resolve(url);
      if (token !== this._loadToken) return;
      this._url = url;
      this._entry = entry;
      this._frame = 0;
      if (autoPlay) {
        this._start(0, true);
        this._status = "PLAYING";
      } else {
        // Buffered while stopped; play() starts it.
        this._status = "STOPPED";
      }
    } finally {
      if (token === this._loadToken) this._emit("stopWaiting");
    }
    this._emit("fileLoaded");
    this._emit("timeupdate");
    if (autoPlay) this._emit("playing");
  }

  async play() {
    this._wake();
    await this._ready;
    if (!this._entry) return;
    if (this._status === "STOPPED") this._start(0, true);
    else this._node.port.postMessage({ cmd: "play" });
    this._status = "PLAYING";
    this._emit("playing");
  }

  pause() {
    if (this._status !== "PLAYING") return;
    this._status = "PAUSED";
    this._node.port.postMessage({ cmd: "pause" });
    this._sleep();
  }

  stop() {
    this._loadToken++;
    this._halt();
  }

  seekToPercentComplete(percent) {
    if (!this._entry || !this._node) return;
    const at = Math.max(0, Math.min(this.duration() * (percent / 100), this.duration() - 0.05));
    if (this._status === "STOPPED") return;
    this._start(at, this._status === "PLAYING");
    this._emit("timeupdate");
  }

  timeElapsed() { return this._frame / this._ctx.sampleRate; }
  duration() { return this._entry ? this._entry.duration : 0; }
  /** Format of the current track, for the kbps/kHz readout. */
  info() { return this._entry; }

  setVolume(v) { this._gain.gain.value = v / 100; }
  setBalance(b) { this._balance.pan.value = b / 100; }
  setPreamp(v) { this._preamp.gain.value = Math.pow(10, ((v / 100) * 24 - 12) / 20); }
  setEqBand(band, v) { this._bands[band].gain.value = (v / 100) * 24 - 12; }
  disableEq() {
    this._input.disconnect();
    this._eqOut.disconnect();
    this._input.connect(this._balance);
  }
  enableEq() {
    this._input.disconnect();
    this._eqOut.disconnect();
    this._input.connect(this._preamp);
    this._eqOut.connect(this._balance);
  }
  getAnalyser() { return this._analyser; }

  dispose() {
    this._loadToken++;
    if (this._worker) this._worker.terminate();
    if (this._el) { this._el.pause(); this._el.srcObject = null; }
    this._ctx.close().catch(() => {});
    this._listeners = {};
  }
}
