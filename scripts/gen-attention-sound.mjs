// Synthesizes the "attention needed" chime as a WAV file — a soft two-note bell
// (ascending fourth, B5 -> E6) with light harmonic shimmer and a faint slap-back
// "room" reflection. No samples/licensing involved; pure additive synthesis.
// Regenerate with: node scripts/gen-attention-sound.mjs
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SR = 44100;
const DURATION = 1.15; // seconds
const N = Math.ceil(SR * DURATION);

function note(freqHz, startSec, tauSec, ampPartials) {
  // ampPartials: [[harmonicRatio, amplitude], ...]
  const startN = Math.floor(startSec * SR);
  const out = new Float32Array(N);
  for (let i = startN; i < N; i++) {
    const t = (i - startN) / SR;
    const env = Math.min(1, t / 0.004) * Math.exp(-t / tauSec);
    let s = 0;
    for (const [ratio, amp] of ampPartials) {
      s += amp * Math.sin(2 * Math.PI * freqHz * ratio * t);
    }
    out[i] += s * env;
  }
  return out;
}

function mix(...layers) {
  const out = new Float32Array(N);
  for (const layer of layers) for (let i = 0; i < N; i++) out[i] += layer[i];
  return out;
}

function addDelayed(base, delaySec, gain) {
  const delayN = Math.floor(delaySec * SR);
  const out = Float32Array.from(base);
  for (let i = 0; i < N; i++) {
    const src = i - delayN;
    if (src >= 0) out[i] += base[src] * gain;
  }
  return out;
}

// Partial stack per note: fundamental, a gentle detuned unison for chorus warmth,
// a soft octave-up shimmer, and a quiet sub-octave for body.
const partialsFor = (f) => [
  [1, 0.62],
  [1.0023, 0.34], // +4 cents detune, chorus width
  [2.0, 0.16], // shimmer
  [0.5, 0.13], // sub warmth
];

const noteB5 = note(987.77, 0.0, 0.42, partialsFor(987.77));
const noteE6 = note(1318.51, 0.115, 0.5, partialsFor(1318.51));

let signal = mix(noteB5, noteE6);
signal = addDelayed(signal, 0.055, 0.16); // faint slap-back reflection

// Fade the last 90ms to zero so the file ends cleanly (no click).
const fadeSamples = Math.floor(0.09 * SR);
for (let i = 0; i < fadeSamples; i++) {
  const idx = N - fadeSamples + i;
  signal[idx] *= 1 - i / fadeSamples;
}

// Normalize to a moderate peak (kept quiet on purpose — the app also plays it
// at reduced Sink volume), then encode as 16-bit PCM mono WAV.
let peak = 0;
for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(signal[i]));
const targetPeak = 0.5; // ~ -6 dBFS pre-app-volume headroom
const scale = peak > 0 ? targetPeak / peak : 1;

const pcm = new Int16Array(N);
for (let i = 0; i < N; i++) {
  const v = Math.max(-1, Math.min(1, signal[i] * scale));
  pcm[i] = Math.round(v * 32767);
}

const bytesPerSample = 2;
const blockAlign = bytesPerSample; // mono
const byteRate = SR * blockAlign;
const dataSize = pcm.length * bytesPerSample;
const buf = Buffer.alloc(44 + dataSize);

buf.write("RIFF", 0, "ascii");
buf.writeUInt32LE(36 + dataSize, 4);
buf.write("WAVE", 8, "ascii");
buf.write("fmt ", 12, "ascii");
buf.writeUInt32LE(16, 16); // PCM fmt chunk size
buf.writeUInt16LE(1, 20); // PCM format
buf.writeUInt16LE(1, 22); // mono
buf.writeUInt32LE(SR, 24);
buf.writeUInt32LE(byteRate, 28);
buf.writeUInt16LE(blockAlign, 32);
buf.writeUInt16LE(16, 34); // bits per sample
buf.write("data", 36, "ascii");
buf.writeUInt32LE(dataSize, 40);
for (let i = 0; i < pcm.length; i++) buf.writeInt16LE(pcm[i], 44 + i * 2);

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "sounds");
writeFileSync(join(outDir, "attention.wav"), buf);
console.log(`Wrote ${outDir}\\attention.wav (${(buf.length / 1024).toFixed(1)} KB, ${DURATION}s)`);
