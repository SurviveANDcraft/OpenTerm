import type { Action } from "./types";

/** Set while the settings keybind recorder is capturing — main handler stands down.
 *  `stop`, when set, tears down the in-progress recording (removes the window
 *  keydown listener and clears `active`) without touching the settings UI —
 *  used to recover if the recording is abandoned instead of finished (e.g.
 *  the settings panel is closed mid-recording), which would otherwise leave
 *  `active` stuck `true` and silently block all future recording attempts. */
export const recorder: { active: boolean; stop: (() => void) | null } = {
  active: false,
  stop: null,
};

/** Cancels an in-progress keybind recording, if any. Safe to call unconditionally. */
export function cancelRecording(): void {
  recorder.stop?.();
}

/** Maps a physical `KeyboardEvent.code` to the label our chord strings use.
 *  `e.code` identifies the physical key regardless of OS keyboard layout;
 *  `e.key` is the character that layout produces, which differs across
 *  layouts (e.g. QWERTZ swaps Y/Z, AZERTY swaps A/Q and Z/W). Matching on
 *  `e.key` meant shortcuts like Ctrl+Shift+Z silently failed to fire on any
 *  PC not using a US QWERTY layout — this table keeps chords tied to the
 *  physical key the user actually presses. */
const CODE_LABELS: Record<string, string> = {
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
  Space: "Space",
};
for (let i = 0; i < 26; i++) {
  const letter = String.fromCharCode(65 + i);
  CODE_LABELS[`Key${letter}`] = letter;
}
for (let i = 0; i <= 9; i++) {
  CODE_LABELS[`Digit${i}`] = String(i);
}

export function chordFromEvent(e: KeyboardEvent): string | null {
  if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Meta");
  // Prefer the physical key (layout-independent) when we have a label for
  // it; fall back to e.key for keys we don't map (arrows, F-keys, Tab,
  // Escape, etc. — those are already layout-independent in e.key).
  let k = CODE_LABELS[e.code];
  if (!k) {
    k = e.key;
    if (k === " ") k = "Space";
    if (k.length === 1) k = k.toUpperCase();
  }
  parts.push(k);
  return parts.join("+");
}

export function actionForChord(
  keybinds: Record<Action, string>,
  chord: string
): Action | null {
  for (const [action, bind] of Object.entries(keybinds)) {
    if (bind === chord) return action as Action;
  }
  return null;
}

/** Pretty print for UI: arrows and small glyphs. */
export function prettyChord(chord: string): string {
  return chord
    .replace("ArrowLeft", "←")
    .replace("ArrowRight", "→")
    .replace("ArrowUp", "↑")
    .replace("ArrowDown", "↓");
}
