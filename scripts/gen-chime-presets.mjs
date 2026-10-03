// Synthesizes the attention chime presets offered in Settings (alongside the
// classic chime from gen-attention-sound.mjs). Three are takes on a soft
// ascending two-note bell, rendered in stereo with a diffuse reverb tail; three
// are short and dry. Every one decays to silence before its file ends.
// Regenerate with: node scripts/gen-chime-presets.mjs
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SR = 48000;
const TAU = Math.PI * 2;
const here = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "sounds");

// ---------- helpers ----------

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cents = (c) => 2 ** (c / 1200);
const attack = (t, a) => (t < a ? 0.5 - 0.5 * Math.cos((Math.PI * t) / a) : 1);

/** Renders `fn(t)` into a stereo buffer from `start`, equal-power panned
 *  (-1 left .. 1 right) with a raised-cosine attack so the onset never clicks. */
function voice(buf, start, pan, attackSec, fn) {
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

function makeBuf(seconds) {
  const n = Math.ceil(seconds * SR);
  return { n, l: new Float64Array(n), r: new Float64Array(n) };
}

function fft(re, im, inverse) {
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

function convolve(x, h) {
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
function roomIR(rt60, seed) {
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

function addReverb(buf, rt60, wet, seed) {
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
function finish(buf, fadeSec, peak = 0.5) {
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

function writeWav(name, buf) {
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

// ---------- the three takes ----------

const B5 = 987.77;
const E6 = 1318.51;
const G5 = 783.99;
const D6 = 1174.66;
const E5 = 659.25;

/** A — Glass. Same notes as today (B5 -> E6), rebuilt as a struck glass bell:
 *  a bright ping that drops quickly into a quieter, longer ring. */
function glass() {
  const buf = makeBuf(2.4);
  const bell = (f, start, gain, pan) => {
    const body = (t) => 0.65 * Math.exp(-t / 0.16) + 0.35 * Math.exp(-t / 0.48);
    for (const [c, p] of [[-1.5, -0.35], [1.5, 0.35]]) {
      const ff = f * cents(c);
      voice(buf, start, pan + p, 0.006, (t) => gain * 0.5 * body(t) * Math.sin(TAU * ff * t));
    }
    voice(buf, start, pan, 0.006, (t) =>
      gain *
      (0.18 * Math.exp(-t / 0.14) * Math.sin(TAU * f * 2 * t) +
        0.05 * Math.exp(-t / 0.08) * Math.sin(TAU * f * 3 * t) +
        0.025 * Math.exp(-t / 0.035) * Math.sin(TAU * f * 5.4 * t) +
        0.08 * Math.exp(-t / 0.3) * Math.sin(TAU * f * 0.5 * t)),
    );
  };
  bell(B5, 0.0, 1.0, -0.12);
  bell(E6, 0.125, 0.9, 0.12);
  addReverb(buf, 1.3, 0.16, 11);
  finish(buf, 1.2);
  return buf;
}

/** B — Mallet. A warmer, rounder take a little lower (G5 -> D6, a fifth):
 *  FM mallet tone with a soft woody knock that melts into a pure fundamental. */
function mallet() {
  const buf = makeBuf(2.0);
  const hit = (f, start, gain, pan) => {
    voice(buf, start, pan, 0.003, (t) => {
      const index = 1.2 * Math.exp(-t / 0.025) + 0.18 * Math.exp(-t / 0.3);
      const env = 0.7 * Math.exp(-t / 0.1) + 0.3 * Math.exp(-t / 0.38);
      const fm = Math.sin(TAU * f * t + index * Math.sin(TAU * f * 4 * t));
      return gain * env * (0.7 * fm + 0.4 * Math.sin(TAU * f * t));
    });
  };
  hit(G5, 0.0, 1.0, -0.18);
  hit(D6, 0.12, 0.85, 0.18);
  addReverb(buf, 0.7, 0.1, 23);
  finish(buf, 0.9);
  return buf;
}

/** C — Halo. The softest and most spacious (E5 -> B5, plus a faint E6
 *  sparkle on top): slow-blooming detuned voices spread wide, long airy tail. */
function halo() {
  const buf = makeBuf(3.2);
  const pad = (f, start, gain, pan) => {
    const env = (t) => 0.5 * Math.exp(-t / 0.25) + 0.5 * Math.exp(-t / 0.6);
    for (const [c, p, a] of [[-5, -0.6, 0.35], [0, 0, 0.5], [5, 0.6, 0.35]]) {
      const ff = f * cents(c);
      voice(buf, start, pan + p, 0.02, (t) => gain * a * env(t) * Math.sin(TAU * ff * t));
    }
    voice(buf, start, pan, 0.02, (t) => gain * 0.1 * Math.exp(-t / 0.25) * Math.sin(TAU * f * 2 * t));
  };
  pad(E5, 0.0, 1.0, -0.1);
  pad(B5, 0.15, 0.85, 0.1);
  pad(E6, 0.34, 0.22, 0.2);
  addReverb(buf, 2.0, 0.28, 37);
  finish(buf, 1.5);
  return buf;
}

// ---------- the short, dry takes (no reverb, no trailing space) ----------

const A5 = 880.0;
const C6 = 1046.5;

/** Rounded decay: holds a little body, then closes to silence quickly — a
 *  "doo" rather than a pluck with a lingering exponential tail. */
const round = (t, d) => Math.exp(-((t / d) ** 2));

/** A dry sine pip with a touch of octave for definition. */
function pip(buf, f, start, gain, pan, d) {
  voice(buf, start, pan, 0.005, (t) =>
    gain * (round(t, d) * Math.sin(TAU * f * t) + 0.14 * round(t, d * 0.6) * Math.sin(TAU * f * 2 * t)),
  );
}

/** D — Dot. One round note (A5) and done. */
function dot() {
  const buf = makeBuf(0.45);
  pip(buf, A5, 0.0, 1.0, 0, 0.13);
  finish(buf, 0.1);
  return buf;
}

/** E — Duo. Two clean pips, a fourth apart (G5 -> C6): "doo-doo". */
function duo() {
  const buf = makeBuf(0.55);
  pip(buf, G5, 0.0, 1.0, -0.1, 0.1);
  pip(buf, C6, 0.115, 0.92, 0.1, 0.11);
  finish(buf, 0.1);
  return buf;
}

/** F — Pluck. Two dry woody mallet taps, a fifth apart (E5 -> B5): the
 *  Mallet's knock without the room. */
function pluck() {
  const buf = makeBuf(0.6);
  const tap = (f, start, gain, pan) => {
    voice(buf, start, pan, 0.003, (t) => {
      const index = 1.3 * Math.exp(-t / 0.02) + 0.12 * Math.exp(-t / 0.15);
      const env = (0.75 * Math.exp(-t / 0.055) + 0.25 * Math.exp(-t / 0.13)) * round(t, 0.22);
      const fm = Math.sin(TAU * f * t + index * Math.sin(TAU * f * 4 * t));
      return gain * env * (0.7 * fm + 0.4 * Math.sin(TAU * f * t));
    });
  };
  tap(E5, 0.0, 1.0, -0.12);
  tap(B5, 0.105, 0.88, 0.12);
  finish(buf, 0.1);
  return buf;
}

// ---------- render ----------

for (const [name, make] of [["glass", glass], ["mallet", mallet], ["halo", halo], ["dot", dot], ["duo", duo], ["pluck", pluck]]) {
  const buf = make();
  writeWav(`${name}.wav`, buf);
  console.log(`Wrote ${join(here, `${name}.wav`)} (${(buf.n / SR).toFixed(2)}s)`);
}
