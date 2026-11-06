// Synthesizes the attention chime presets offered in Settings (alongside the
// classic chime from gen-attention-sound.mjs). Three are takes on a soft
// ascending two-note bell, rendered in stereo with a diffuse reverb tail; three
// are short and dry. Every one decays to silence before its file ends.
// Regenerate with: node scripts/gen-chime-presets.mjs
import { join } from "node:path";
import { SR, TAU, cents, voice, makeBuf, addReverb, finish, writeWav, here } from "./synth.mjs";

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
