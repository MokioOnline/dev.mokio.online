import "./polyfills.js";
import RnnoiseProcessor from "./RnnoiseProcessor.js";
import createRNNWasmModuleSync from "./generated/rnnoise-sync.js";
import { NoiseSuppressorWorklet_Name } from "./index.js";

const FRAME = 480;
const TARGET_RATE = 48000;

function resample(src, srcRate, dstRate) {
  if (srcRate === dstRate) return src;
  const dstLen = Math.max(1, Math.round(src.length * dstRate / srcRate));
  const out = new Float32Array(dstLen);
  const scale = (src.length - 1) / Math.max(1, dstLen - 1);
  for (let i = 0; i < dstLen; i++) {
    const pos = i * scale;
    const i0 = Math.floor(pos);
    const i1 = Math.min(src.length - 1, i0 + 1);
    const t = pos - i0;
    out[i] = src[i0] * (1 - t) + src[i1] * t;
  }
  return out;
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
    this.nativeFrame = Math.max(1, Math.round(this.inRate * FRAME / TARGET_RATE));
    this.needResample = Math.abs(this.inRate - TARGET_RATE) > 1;
    this.inBuf = new Float32Array(this.nativeFrame * 4);
    this.inLen = 0;
    this.outBuf = new Float32Array(this.nativeFrame * 8);
    this.outRead = 0;
    this.outWrite = 0;
    this.outCount = 0;
    this.frame48 = new Float32Array(FRAME);
    this.hpX = 0;
    this.hpY = 0;
    this.hpA = Math.exp(-2 * Math.PI * 70 / this.inRate);
    this.gain = 1;
    this.last = 0;
    this.primed = false;
    this.clean = new Float32Array(FRAME);
  }

  pushOut(samples) {
    for (let i = 0; i < samples.length; i++) {
      this.outBuf[this.outWrite] = samples[i];
      this.outWrite = (this.outWrite + 1) % this.outBuf.length;
      if (this.outCount < this.outBuf.length) this.outCount++;
      else this.outRead = (this.outRead + 1) % this.outBuf.length;
    }
  }

  pullOut(dst) {
    const n = dst.length;
    if (this.outCount < n) return false;
    for (let i = 0; i < n; i++) {
      dst[i] = this.outBuf[this.outRead];
      this.outRead = (this.outRead + 1) % this.outBuf.length;
    }
    this.outCount -= n;
    return true;
  }

  denoiseNative(native) {
    let frame = native;
    if (this.needResample) frame = resample(native, this.inRate, TARGET_RATE);
    if (frame.length !== FRAME) {
      const exact = new Float32Array(FRAME);
      exact.set(frame.subarray(0, Math.min(FRAME, frame.length)));
      frame = exact;
    }
    this.frame48.set(frame.subarray(0, FRAME));
    let vad = 1;
    if (this.ok && this.proc) {
      try { vad = this.proc.processAudioFrame(this.frame48, true); } catch (_) { vad = 1; }
    }
    if (!Number.isFinite(vad)) vad = 1;
    let target = 1;
    if (vad < 0.12) target = 0.04;
    else if (vad < 0.4) target = 0.08 + (vad - 0.12) * 1.4;
    else if (vad < 0.65) target = 0.55 + (vad - 0.4) * 1.8;
    const outLen = this.needResample ? Math.max(1, Math.round(FRAME * this.inRate / TARGET_RATE)) : FRAME;
    if (this.clean.length !== outLen) this.clean = new Float32Array(outLen);
    const cleaned = this.needResample ? resample(this.frame48, TARGET_RATE, this.inRate) : this.frame48;
    const coeffOpen = 0.4;
    const coeffClose = 0.08;
    const n = Math.min(outLen, cleaned.length);
    for (let i = 0; i < n; i++) {
      const coeff = target > this.gain ? coeffOpen : coeffClose;
      this.gain += (target - this.gain) * coeff;
      let s = cleaned[i] * this.gain;
      if (s > 0.98) s = 0.98;
      else if (s < -0.98) s = -0.98;
      this.clean[i] = s;
    }
    return this.clean.subarray(0, n);
  }

  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0];
    const output = outputs[0] && outputs[0][0];
    if (!output) return true;
    if (!input) {
      output.fill(0);
      return true;
    }

    const a = this.hpA;
    for (let i = 0; i < input.length; i++) {
      const x = input[i] || 0;
      const y = a * (this.hpY + x - this.hpX);
      this.hpX = x;
      this.hpY = y;
      this.inBuf[this.inLen++] = y;
      if (this.inLen === this.nativeFrame) {
        const native = this.inBuf.subarray(0, this.nativeFrame);
        const clean = this.denoiseNative(native);
        this.pushOut(clean);
        this.inLen = 0;
      }
    }

    if (!this.pullOut(output)) {
      if (!this.primed) {
        output.set(input.subarray(0, output.length));
      } else {
        for (let i = 0; i < output.length; i++) output[i] = this.last;
      }
    } else {
      this.primed = true;
    }
    this.last = output[output.length - 1] || 0;
    return true;
  }
}

registerProcessor(NoiseSuppressorWorklet_Name, NoiseSuppressorWorklet);
