/** Icons for the Agents panel, from Phosphor (regular weight, one family).
 *  Imported per file as raw SVG so only these glyphs land in the bundle; the
 *  markup uses currentColor, so CSS colours them. */

import x from "@phosphor-icons/core/regular/x.svg?raw";
import sparkle from "@phosphor-icons/core/regular/sparkle.svg?raw";
import notePencil from "@phosphor-icons/core/regular/note-pencil.svg?raw";
import arrowUp from "@phosphor-icons/core/bold/arrow-up-bold.svg?raw";
import stop from "@phosphor-icons/core/fill/stop-fill.svg?raw";
import chat from "@phosphor-icons/core/regular/chat-circle-text.svg?raw";
import caretDown from "@phosphor-icons/core/regular/caret-down.svg?raw";
import terminal from "@phosphor-icons/core/regular/terminal-window.svg?raw";
import search from "@phosphor-icons/core/regular/magnifying-glass.svg?raw";
import info from "@phosphor-icons/core/regular/info.svg?raw";
import arrowRight from "@phosphor-icons/core/regular/arrow-right.svg?raw";
import spinner from "@phosphor-icons/core/bold/circle-notch-bold.svg?raw";
import warning from "@phosphor-icons/core/fill/warning-circle-fill.svg?raw";
import bell from "@phosphor-icons/core/fill/bell-simple-ringing-fill.svg?raw";
import arrowUpRight from "@phosphor-icons/core/regular/arrow-up-right.svg?raw";
import check from "@phosphor-icons/core/bold/check-bold.svg?raw";

const RAW = {
  x,
  sparkle,
  notePencil,
  arrowUp,
  stop,
  chat,
  caretDown,
  terminal,
  search,
  info,
  arrowRight,
  spinner,
  warning,
  bell,
  arrowUpRight,
  check,
};

export type IconName = keyof typeof RAW;

const sized = new Map<string, string>();

/** The icon at `size` px, with aria-hidden (every use sits next to a label or
 *  inside a titled button). */
export function icon(name: IconName, size = 16): string {
  const key = `${name}:${size}`;
  let svg = sized.get(key);
  if (!svg) {
    svg = RAW[name].replace(
      "<svg ",
      `<svg width="${size}" height="${size}" aria-hidden="true" focusable="false" class="ph ph-${name}" `
    );
    sized.set(key, svg);
  }
  return svg;
}
