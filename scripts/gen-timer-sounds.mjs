// Synthesizes the timer sounds (see src-tauri/src/timers.rs):
//   timer-tick.wav / timer-tock.wav — a fine mechanical escapement, played
//     once a second through a timer's last 15 seconds, alternating;
//   timer-ring.wav — one bar of the alarm, built to loop seamlessly.
// Regenerate with: node scripts/gen-timer-sounds.mjs
import { join } from "node:path";
import { SR, TAU, rng, voice, makeBuf, addReverb, finish, writeWav, here } from "./synth.mjs";

// ---------- tick ----------

/** A watch escapement: a bright metallic click (a few fast-dying, slightly
 *  inharmonic resonances) over a short woody knock, in a small room. `pitch`
 *  shifts the whole body so tick and tock are a pair rather than a repeat. */
function tick(pitch, pan, seed) {
  const buf = makeBuf(0.32);
  const rand = rng(seed);

  // Strike: a 2 ms burst of band-limited noise.
  let lp = 0;
  let hp = 0;
  let prev = 0;
  voice(buf, 0, pan, 0.0004, (t) => {
    if (t > 0.004) return 0;
    lp += 0.55 * (rand() * 2 - 1 - lp);
    hp = 0.82 * (hp + lp - prev);
    prev = lp;
    return 0.55 * hp * Math.exp(-t / 0.0007);
  });

  // Metal: the escape wheel's ring.
  const metal = [
    [2840, 0.0105, 0.5],
    [4170, 0.0068, 0.32],
    [5960, 0.0042, 0.2],
    [7710, 0.0026, 0.12],
  ];
  for (const [f, tau, a] of metal) {
    const ff = f * pitch;
    const ph = rand() * TAU;
    voice(buf, 0, pan, 0.0003, (t) => a * Math.exp(-t / tau) * Math.sin(TAU * ff * t + ph));
  }

  // Wood: the case answering, a touch later and lower.
  for (const [f, tau, a, delay] of [
    [1180, 0.016, 0.28, 0.0006],
    [690, 0.02, 0.2, 0.0009],
    [210, 0.012, 0.16, 0.0],
  ]) {
    const ff = f * pitch;
    voice(buf, delay, pan, 0.0008, (t) => a * Math.exp(-t / tau) * Math.sin(TAU * ff * t));
  }

  addReverb(buf, 0.28, 0.07, seed + 101);
  finish(buf, 0.12, 0.5);
  return buf;
}

// ---------- ring ----------

const PERIOD = 2.4;

const A4 = 440.0;
const A5 = 880.0;
const Cs6 = 1108.73;
const E6 = 1318.51;
const A6 = 1760.0;

/** A struck crystal bell: a warm detuned fundamental, glassy inharmonic
 *  partials that die fast, and a soft mallet tick on the attack. */
function bell(buf, f, start, gain, pan, seed) {
  const rand = rng(seed);
  const body = (t) => 0.6 * Math.exp(-t / 0.22) + 0.4 * Math.exp(-t / 0.95);
  for (const [cents, p] of [
    [-3, -0.3],
    [3, 0.3],
  ]) {
    const ff = f * 2 ** (cents / 1200);
    voice(buf, start, pan + p, 0.004, (t) => gain * 0.48 * body(t) * Math.sin(TAU * ff * t));
  }
  voice(buf, start, pan, 0.004, (t) =>
    gain *
    (0.2 * Math.exp(-t / 0.3) * Math.sin(TAU * f * 2.0 * t) +
      0.11 * Math.exp(-t / 0.16) * Math.sin(TAU * f * 2.76 * t) +
      0.05 * Math.exp(-t / 0.07) * Math.sin(TAU * f * 5.4 * t) +
      0.022 * Math.exp(-t / 0.035) * Math.sin(TAU * f * 8.93 * t) +
      0.09 * Math.exp(-t / 0.5) * Math.sin(TAU * f * 0.5 * t)),
  );
  // Mallet: a breath of filtered noise so each note has a felt onset.
  let lp = 0;
  voice(buf, start, pan, 0.0008, (t) => {
    if (t > 0.012) return 0;
    lp += 0.35 * (rand() * 2 - 1 - lp);
    return gain * 0.12 * lp * Math.exp(-t / 0.0025);
  });
}

/** One bar: a rising A-major arpeggio and its softer answer, over a low bloom.
 *  Rendered three bars long and cut from the middle, so the copy carries the
 *  previous bar's tail into its start and loops without a seam. */
function ring() {
  const bars = 3;
  const buf = makeBuf(PERIOD * bars + 0.1);
  let seed = 500;
  for (let b = 0; b < bars; b++) {
    const t0 = b * PERIOD;
    bell(buf, A5, t0 + 0.0, 1.0, -0.25, seed++);
    bell(buf, Cs6, t0 + 0.13, 0.86, -0.08, seed++);
    bell(buf, E6, t0 + 0.26, 0.8, 0.08, seed++);
    bell(buf, A6, t0 + 0.39, 0.66, 0.25, seed++);
    bell(buf, E6, t0 + 0.86, 0.5, 0.18, seed++);
    bell(buf, A6, t0 + 0.99, 0.42, 0.3, seed++);
    bell(buf, A4, t0 + 0.0, 0.32, 0, seed++);
  }
  addReverb(buf, 1.7, 0.22, 77);

  const n = Math.round(PERIOD * SR);
  const from = n; // the middle bar
  const out = makeBuf(PERIOD);
  out.l.set(buf.l.subarray(from, from + n));
  out.r.set(buf.r.subarray(from, from + n));
  // No end fade: the loop continues straight into its own start.
  let p = 0;
  for (let i = 0; i < out.n; i++) p = Math.max(p, Math.abs(out.l[i]), Math.abs(out.r[i]));
  const g = 0.62 / p;
  for (let i = 0; i < out.n; i++) (out.l[i] *= g), (out.r[i] *= g);
  return out;
}

for (const [name, make] of [
  ["timer-tick", () => tick(1.0, -0.12, 11)],
  ["timer-tock", () => tick(0.86, 0.12, 29)],
  ["timer-ring", ring],
]) {
  const buf = make();
  writeWav(`${name}.wav`, buf);
  console.log(`Wrote ${join(here, `${name}.wav`)} (${(buf.n / SR).toFixed(2)}s)`);
}
