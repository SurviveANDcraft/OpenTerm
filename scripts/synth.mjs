// Offline synthesis helpers shared by the sound generators (chime presets,
// timer sounds): stereo voices, a diffuse convolution reverb and a dithered
// 16-bit WAV writer. Everything renders at 48 kHz.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const SR = 48000;
export const TAU = Math.PI * 2;
export const here = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "sounds");

// ---------- helpers ----------

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const cents = (c) => 2 ** (c / 1200);
export const attack = (t, a) => (t < a ? 0.5 - 0.5 * Math.cos((Math.PI * t) / a) : 1);

/** Renders `fn(t)` into a stereo buffer from `start`, equal-power panned
 *  (-1 left .. 1 right) with a raised-cosine attack so the onset never clicks. */
export function voice(buf, start, pan, attackSec, fn) {
  const ang = ((Math.max(-1, Math.min(1, pan)) + 1) * Math.PI) / 4;
  const gl = Math.cos(ang);
  const gr = Math.sin(ang);
  const n0 = Math.floor(start * SR);
  for (let i = n0; i < buf.n; i++) {
    const t = (i - n0) / SR;
    const s = fn(t) * attack(t, attackSec);
    buf.l[i] += s * gl;
    buf.r[i] += s * gr;
  }
}

export function makeBuf(seconds) {
  const n = Math.ceil(seconds * SR);
  return { n, l: new Float64Array(n), r: new Float64Array(n) };
}

export function fft(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? -1 : 1) * TAU) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) (re[i] /= n), (im[i] /= n);
}

export function convolve(x, h) {
  let size = 1;
  while (size < x.length + h.length) size <<= 1;
  const xr = new Float64Array(size);
  const xi = new Float64Array(size);
  const hr = new Float64Array(size);
  const hi = new Float64Array(size);
  xr.set(x);
  hr.set(h);
  fft(xr, xi, false);
  fft(hr, hi, false);
  for (let i = 0; i < size; i++) {
    const a = xr[i] * hr[i] - xi[i] * hi[i];
    xi[i] = xr[i] * hi[i] + xi[i] * hr[i];
    xr[i] = a;
  }
  fft(xr, xi, true);
  return xr;
}

/** A diffuse room impulse response: decaying noise whose highs die faster
 *  than its lows, with a short pre-delay and a soft build-up instead of a
 *  discrete echo (the old chime's single slap-back is what sounded "wrong"). */
export function roomIR(rt60, seed) {
  const rand = rng(seed);
  const pre = Math.floor(0.012 * SR);
  const len = Math.floor(rt60 * 1.25 * SR);
  const ir = new Float64Array(pre + len);
  const tau = rt60 / 6.91;
  let lp = 0;
  let hpIn = 0;
  let hp = 0;
  const hpA = 1 / (1 + (TAU * 280) / SR);
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const cutoff = 2200 + 7000 * Math.exp(-t / (rt60 * 0.3));
    const a = 1 - Math.exp((-TAU * cutoff) / SR);
    lp += a * (rand() * 2 - 1 - lp);
    hp = hpA * (hp + lp - hpIn);
    hpIn = lp;
    const build = attack(t, 0.008);
    const tailFade = t > rt60 * 0.8 ? 0.5 + 0.5 * Math.cos((Math.PI * (t - rt60 * 0.8)) / (rt60 * 0.45)) : 1;
    ir[pre + i] = hp * Math.exp(-t / tau) * build * tailFade;
  }
  let e = 0;
  for (const v of ir) e += v * v;
  const g = 1 / Math.sqrt(e);
  for (let i = 0; i < ir.length; i++) ir[i] *= g;
  return ir;
}

export function addReverb(buf, rt60, wet, seed) {
  const mono = new Float64Array(buf.n);
  for (let i = 0; i < buf.n; i++) mono[i] = (buf.l[i] + buf.r[i]) * 0.5;
  const wl = convolve(mono, roomIR(rt60, seed));
  const wr = convolve(mono, roomIR(rt60, seed + 7919));
  for (let i = 0; i < buf.n; i++) {
    buf.l[i] += wl[i] * wet;
    buf.r[i] += wr[i] * wet;
  }
}

/** Eases the whole mix to true zero over the final `fadeSec`. By then the
 *  notes have already decayed most of the way on their own, so this only
 *  shapes the last whisper of the tail rather than chopping an audible ring. */
export function finish(buf, fadeSec, peak = 0.5) {
  const f = Math.floor(fadeSec * SR);
  for (let i = 0; i < f; i++) {
    const g = 0.5 + 0.5 * Math.cos((Math.PI * i) / f);
    const idx = buf.n - f + i;
    buf.l[idx] *= g;
    buf.r[idx] *= g;
  }
  let p = 0;
  for (let i = 0; i < buf.n; i++) p = Math.max(p, Math.abs(buf.l[i]), Math.abs(buf.r[i]));
  const s = peak / p;
  for (let i = 0; i < buf.n; i++) (buf.l[i] *= s), (buf.r[i] *= s);
}

export function writeWav(name, buf) {
  const rand = rng(1234);
  const data = Buffer.alloc(44 + buf.n * 4);
  data.write("RIFF", 0, "ascii");
  data.writeUInt32LE(36 + buf.n * 4, 4);
  data.write("WAVE", 8, "ascii");
  data.write("fmt ", 12, "ascii");
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(2, 22);
  data.writeUInt32LE(SR, 24);
  data.writeUInt32LE(SR * 4, 28);
  data.writeUInt16LE(4, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36, "ascii");
  data.writeUInt32LE(buf.n * 4, 40);
  // TPDF dither keeps the quiet tail from turning gritty at 16 bits.
  const q = (v) => Math.max(-32768, Math.min(32767, Math.round(v * 32767 + rand() - rand())));
  for (let i = 0; i < buf.n; i++) {
    data.writeInt16LE(q(buf.l[i]), 44 + i * 4);
    data.writeInt16LE(q(buf.r[i]), 46 + i * 4);
  }
  writeFileSync(join(here, name), data);
}
