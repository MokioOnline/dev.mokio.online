class MokioDenoise extends AudioWorkletProcessor {
  constructor() {
    super();
    this.n = 512;
    this.win = new Float32Array(this.n);
    for (let i = 0; i < this.n; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / this.n);
    this.buf = new Float32Array(this.n);
    this.ola = new Float32Array(this.n);
    this.re = new Float32Array(this.n);
    this.im = new Float32Array(this.n);
    this.noise = new Float32Array(this.n / 2 + 1);
    this.noise.fill(2e-7);
    this.ready = 0;
    this.hpX1 = 0;
    this.hpX2 = 0;
    this.hpY1 = 0;
    this.hpY2 = 0;
    const sr = sampleRate || 48000;
    const w0 = 2 * Math.PI * 80 / sr;
    const alpha = Math.sin(w0) / (2 * 0.707);
    const cosw = Math.cos(w0);
    const b0 = (1 + cosw) / 2;
    const b1 = -(1 + cosw);
    const b2 = (1 + cosw) / 2;
    const a0 = 1 + alpha;
    this.hpB0 = b0 / a0;
    this.hpB1 = b1 / a0;
    this.hpB2 = b2 / a0;
    this.hpA1 = (-2 * cosw) / a0;
    this.hpA2 = (1 - alpha) / a0;
    this.binHz = sr / this.n;
  }

  fft(re, im, inverse) {
    const n = this.n;
    let j = 0;
    for (let i = 0; i < n; i++) {
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
      let m = n >> 1;
      while (m >= 1 && j >= m) { j -= m; m >>= 1; }
      j += m;
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = (inverse ? 2 : -2) * Math.PI / size;
      for (let i = 0; i < n; i += size) {
        for (let k = 0; k < half; k++) {
          const ang = step * k;
          const wr = Math.cos(ang);
          const wi = Math.sin(ang);
          const ir = re[i + k + half];
          const ii = im[i + k + half];
          const tr = wr * ir - wi * ii;
          const ti = wr * ii + wi * ir;
          re[i + k + half] = re[i + k] - tr;
          im[i + k + half] = im[i + k] - ti;
          re[i + k] += tr;
          im[i + k] += ti;
        }
      }
    }
    if (inverse) {
      for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
    }
  }

  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0];
    const output = outputs[0] && outputs[0][0];
    if (!output) return true;
    const hop = output.length;
    const n = this.n;
    this.buf.copyWithin(0, hop);
    if (input) {
      for (let i = 0; i < hop; i++) {
        const x = input[i] || 0;
        const y = this.hpB0 * x + this.hpB1 * this.hpX1 + this.hpB2 * this.hpX2 - this.hpA1 * this.hpY1 - this.hpA2 * this.hpY2;
        this.hpX2 = this.hpX1; this.hpX1 = x;
        this.hpY2 = this.hpY1; this.hpY1 = y;
        this.buf[n - hop + i] = y;
      }
    } else {
      this.buf.fill(0, n - hop);
    }
    this.ready += hop;
    if (this.ready >= n) {
      for (let i = 0; i < n; i++) {
        this.re[i] = this.buf[i] * this.win[i];
        this.im[i] = 0;
      }
      this.fft(this.re, this.im, false);
      const bins = n / 2;
      let speechPow = 0;
      let noisePow = 0;
      for (let k = 1; k <= bins; k++) {
        const hz = k * this.binHz;
        if (hz < 200 || hz > 3800) continue;
        const p = this.re[k] * this.re[k] + this.im[k] * this.im[k];
        speechPow += p;
        noisePow += this.noise[k];
      }
      const speech = speechPow / Math.max(noisePow, 1e-12) > 2.2;
      const noiseAlpha = speech ? 0.996 : 0.88;
      for (let k = 0; k <= bins; k++) {
        const hz = k * this.binHz;
        const p = this.re[k] * this.re[k] + this.im[k] * this.im[k] + 1e-12;
        this.noise[k] = noiseAlpha * this.noise[k] + (1 - noiseAlpha) * p;
        const xi = Math.max(p / Math.max(this.noise[k], 1e-12) - 1, 0);
        let g = xi / (xi + 1);
        let floor = 0.08;
        if (hz < 120) floor = 0.02;
        else if (hz < 200) floor = 0.05;
        else if (hz <= 3800) floor = 0.16;
        else if (hz < 7000) floor = 0.06;
        else floor = 0.025;
        if (!speech && hz > 4500) floor *= 0.4;
        g = Math.max(g, floor);
        this.re[k] *= g;
        this.im[k] *= g;
        if (k > 0 && k < n - k) {
          this.re[n - k] *= g;
          this.im[n - k] *= g;
        }
      }
      this.fft(this.re, this.im, true);
      for (let i = 0; i < n; i++) this.ola[i] += this.re[i] * this.win[i];
    }
    for (let i = 0; i < hop; i++) {
      let y = this.ola[i] || 0;
      if (y > 0.94) y = 0.94;
      if (y < -0.94) y = -0.94;
      output[i] = y;
    }
    this.ola.copyWithin(0, hop);
    this.ola.fill(0, n - hop);
    return true;
  }
}

registerProcessor('mokio-denoise', MokioDenoise);
