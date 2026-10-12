// Plays one continuous PCM stream. The decode worker posts chunks straight to
// this processor over its own MessagePort; consecutive tracks arrive as one
// unbroken run of samples, which is the whole trick behind gapless playback.
//
// A "generation" is one such run. Seeking or picking another track starts a new
// one, and anything still in flight from the old one is dropped.

const REPORT_FRAMES = 8192; // ~5 position updates a second at 44.1 kHz

class GaplessPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.gen = 0;
    this.playing = false;
    this.reset(0);
    this.port.onmessage = e => this.onMain(e.data);
  }

  reset(gen) {
    this.gen = gen;
    this.queue = [];
    this.consumed = 0;
    this.seq = -1;
    this.frame = 0;
    this.ended = false;
    this.sinceReport = 0;
  }

  onMain(m) {
    if (m.cmd === "port") {
      this.worker = m.port;
      this.worker.onmessage = e => this.onChunk(e.data);
    } else if (m.cmd === "flush") {
      // The flush and the first chunk of the new generation travel on different
      // ports, so either can arrive first. Whichever does starts the generation.
      if (m.gen > this.gen) this.reset(m.gen);
      this.playing = m.playing;
    } else if (m.cmd === "play") this.playing = true;
    else if (m.cmd === "pause") this.playing = false;
  }

  onChunk(c) {
    if (c.gen > this.gen) this.reset(c.gen);
    if (c.gen !== this.gen) return;
    // More audio after an end marker means the worker learned of another track
    // in time: the stream didn't end there after all.
    const tail = this.queue[this.queue.length - 1];
    if (tail && tail.end && !c.end) this.queue.pop();
    if (!this.ended) this.queue.push(c);
  }

  report() {
    this.sinceReport = 0;
    this.port.postMessage({ type: "pos", gen: this.gen, seq: this.seq, frame: this.frame });
    if (this.worker) this.worker.postMessage({ gen: this.gen, consumed: this.consumed });
  }

  process(inputs, outputs) {
    if (!this.playing) return true;
    const [left, right] = outputs[0];
    const want = left.length;
    let o = 0;

    while (o < want) {
      const c = this.queue[0];
      if (!c) break; // starved: the rest of this block stays silent
      if (c.end) {
        this.queue.shift();
        if (!this.ended) {
          this.ended = true;
          this.port.postMessage({ type: "ended", gen: this.gen, played: this.consumed + o });
        }
        break;
      }
      if (c.start && !c.off) {
        this.seq = c.seq;
        this.frame = c.base;
        this.port.postMessage({ type: "track", gen: this.gen, seq: c.seq, key: c.key });
      }
      const off = c.off || 0;
      const n = Math.min(want - o, c.l.length - off);
      left.set(c.l.subarray(off, off + n), o);
      if (right) right.set(c.r.subarray(off, off + n), o);
      c.off = off + n;
      c.start = false;
      o += n;
      if (c.off >= c.l.length) this.queue.shift();
    }

    this.frame += o;
    this.consumed += o;
    this.sinceReport += want;
    if (this.sinceReport >= REPORT_FRAMES) this.report();
    return true;
  }
}

registerProcessor("gapless-player", GaplessPlayer);
