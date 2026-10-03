import "./polyfills.js";
import RnnoiseProcessor from "./RnnoiseProcessor.js";
import createRNNWasmModuleSync from "./generated/rnnoise-sync.js";
import { NoiseSuppressorWorklet_Name } from "./index.js";

const FRAME = 480;
const TARGET_RATE = 48000;
const RING = FRAME * 24;
const HIST = 8192;

function coeffFor(ms, rate) {
  return 1 - Math.exp(-1 / Math.max(1, (ms / 1000) * rate));
}

class NoiseSuppressorWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ok = false;
    try {
      this.proc = new RnnoiseProcessor(createRNNWasmModuleSync());
      this.ok = true;
    } catch (_) {
      this.proc = null;
    }
    this.inRate = sampleRate || TARGET_RATE;
    this.sameRate = Math.abs(this.inRate - TARGET_RATE) < 1;
    this.frame = new Float32Array(FRAME);
    this.frameFill = 0;
    this.out = new Float32Array(RING);
    this.outR = 0;
    this.outW = 0;
    this.outN = 0;
    this.hpX = 0;
    this.hpY = 0;
    this.hpA = Math.exp(-2 * Math.PI * 75 / this.inRate);
    this.gain = 1;
    this.attack = coeffFor(6, TARGET_RATE);
    this.release = coeffFor(140, TARGET_RATE);
    this.last = 0;
    this.primed = false;
    this.inRing = new Float32Array(HIST);
    this.inAbs = 0;
    this.k48 = 0;
    this.denRing = new Float32Array(HIST);
    this.denAbs = 0;
    this.kNative = 0;
    try { this.port.postMessage({ ready: this.ok }); } catch (_) {}
  }

  pushOut(sample) {
    this.out[this.outW] = sample;
    this.outW = (this.outW + 1) % RING;
    if (this.outN < RING) this.outN++;
    else this.outR = (this.outR + 1) % RING;
  }

  pullOut(dst) {
    const n = dst.length;
    if (this.outN < n) return false;
    for (let i = 0; i < n; i++) {
      dst[i] = this.out[this.outR];
      this.outR = (this.outR + 1) % RING;
    }
    this.outN -= n;
    this.last = dst[n - 1] || 0;
    return true;
  }

  fade(dst) {
    for (let i = 0; i < dst.length; i++) {
      this.last *= 0.9;
      dst[i] = this.last;
    }
  }

  vadTarget(vad) {
    if (vad >= 0.5) return 1;
    if (vad <= 0.06) return 0.12;
    return 0.12 + ((vad - 0.06) / 0.44) * 0.88;
  }

  finishFrame() {
    let vad = 1;
    if (this.ok && this.proc) {
      try { vad = this.proc.processAudioFrame(this.frame, true); } catch (_) { vad = 1; }
    }
    if (!Number.isFinite(vad)) vad = 1;
    if (vad < 0) vad = 0;
    else if (vad > 1) vad = 1;
    const target = this.vadTarget(vad);
    for (let i = 0; i < FRAME; i++) {
      const k = target > this.gain ? this.attack : this.release;
      this.gain += (target - this.gain) * k;
      let s = this.frame[i] * 1.1 * this.gain;
      if (s > 0.98) s = 0.98;
      else if (s < -0.98) s = -0.98;
      if (this.sameRate) this.pushOut(s);
      else this.pushDenoised(s);
    }
    this.frameFill = 0;
  }

  pushDenoised(sample) {
    this.denRing[this.denAbs & (HIST - 1)] = sample;
    this.denAbs++;
    const step = TARGET_RATE / this.inRate;
    while (this.kNative * step + 1 < this.denAbs) {
      const pos = this.kNative * step;
      const i0 = Math.floor(pos);
      const t = pos - i0;
      const s0 = this.denRing[i0 & (HIST - 1)];
      const s1 = this.denRing[(i0 + 1) & (HIST - 1)];
      this.pushOut(s0 * (1 - t) + s1 * t);
      this.kNative++;
    }
  }

  push48(sample) {
    if (this.sameRate) {
      this.frame[this.frameFill++] = sample;
      if (this.frameFill === FRAME) this.finishFrame();
      return;
    }
    this.inRing[this.inAbs & (HIST - 1)] = sample;
    this.inAbs++;
    const step = this.inRate / TARGET_RATE;
    while (this.k48 * step + 1 < this.inAbs) {
      const pos = this.k48 * step;
      const i0 = Math.floor(pos);
      const t = pos - i0;
      const s0 = this.inRing[i0 & (HIST - 1)];
      const s1 = this.inRing[(i0 + 1) & (HIST - 1)];
      const y = s0 * (1 - t) + s1 * t;
      this.k48++;
      this.frame[this.frameFill++] = y;
      if (this.frameFill === FRAME) this.finishFrame();
    }
  }

  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0];
    const output = outputs[0] && outputs[0][0];
    if (!output) return true;

    if (input && input.length) {
      const a = this.hpA;
      for (let i = 0; i < input.length; i++) {
        const x = input[i] || 0;
        const y = a * (this.hpY + x - this.hpX);
        this.hpX = x;
        this.hpY = y;
        this.push48(y);
      }
    }

    const n = output.length;
    if (!this.primed && this.outN >= FRAME + n) this.primed = true;
    if (this.primed && this.outN >= n) this.pullOut(output);
    else if (this.primed) this.fade(output);
    else output.fill(0);
    return true;
  }
}

registerProcessor(NoiseSuppressorWorklet_Name, NoiseSuppressorWorklet);
