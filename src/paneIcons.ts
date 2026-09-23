/** Marks for whatever a pane is running — an AI agent CLI, or the plain shell
 *  underneath it — drawn into the pane title bar so a wall of terminals is
 *  readable at a glance.
 *
 *  Paths are the vendors' own marks (24×24, single-path, fill-rule agnostic),
 *  sourced from the vendor or the Simple Icons set. The logos remain their
 *  owners' trademarks; they are used here only to label the tool actually
 *  running in the pane.
 *
 *  Agent marks keep their brand color where the color carries the identity;
 *  shell marks are deliberately monochrome and drawn back a stop (see the
 *  `.shell` rule in styles.css), so "a colored logo" reads as *an agent is
 *  running here* and a grey glyph reads as *just a terminal*. */

export type AgentBrand = "claude" | "codex" | "opencode" | "cursor" | "gemini" | "grok";

export type ShellBrand = "powershell" | "cmd" | "bash" | "zsh" | "wsl" | "shell";

export type PaneBrand = AgentBrand | ShellBrand;

/** How a mark takes its color:
 *   - "text"     — monochrome brand (OpenAI, OpenCode, Cursor and every shell
 *                  ship a black/white mark); inherits the title bar's own color
 *                  so it stays legible in every theme, light or dark.
 *   - "brand"    — a single brand hue, used where the color *is* the mark.
 *   - "gradient" — Gemini's blue→violet→rose sweep, which is as much of the
 *                  identity as the star's shape. */
type Tone = "text" | "brand" | "gradient";

interface Mark {
  label: string;
  path: string;
  /** Optical size correction, applied about the mark's centre.
   *
   *  Every mark fills its 24×24 box, but a solid square reads far larger than a
   *  spiky star of the same bounds — so matching the boxes would leave OpenCode
   *  at twice the weight of Gemini. These shrink the denser shapes until the set
   *  reads as one row: the airiest marks (Claude's burst, Gemini's star) stay at
   *  full size and everything else is pulled in. */
  scale: number;
  tone: Tone;
  /** Only for tone "brand". */
  color?: string;
  /** Set for marks drawn as strokes rather than filled silhouettes, including
   *  the hand-drawn generic prompt and fine-line vendor marks. */
  stroke?: number;
}

const MARKS: Record<PaneBrand, Mark> = {
  claude: {
    label: "Claude Code",
    // Anthropic's burst.
    path: "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z",
    scale: 1,
    tone: "brand",
    color: "#d97757",
  },
  codex: {
    label: "Codex",
    // OpenAI's knot — Codex ships no separate mark of its own.
    path: "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z",
    scale: 0.94,
    tone: "text",
  },
  opencode: {
    label: "OpenCode",
    path: "M22 24H2V0h20zM17 4.8H7v14.4h10z",
    // A hard-edged rectangle that fills its corners, so it takes the biggest
    // correction of the five — but only to about the cube's size: pulled in any
    // further it stops reading as a mark and starts reading as a speck.
    scale: 0.84,
    tone: "text",
  },
  cursor: {
    label: "Cursor Agent",
    path: "M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23",
    scale: 0.86,
    tone: "text",
  },
  gemini: {
    label: "Gemini CLI",
    path: "M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81",
    scale: 1,
    tone: "gradient",
  },
  grok: {
    label: "Grok Build",
    // SpaceXAI's horizon-crossed X, simplified to hold up at title-bar size.
    path: "M2 17.8C7.6 12.7 14.1 8.6 22 5.8M5.7 17.8C10.3 13.4 15.8 9.9 22 7.2M3.3 8.7l3.7 3 1.6-1-2.7-2H3.3m5.8 6.5 3.4 2.6h5.8l-5.8-4.7m-.8-1 2.2 1.7 1.5-.9 5.8 4.9h-4",
    scale: 0.98,
    tone: "text",
    stroke: 0.9,
  },

  // ---- shells ----

  powershell: {
    label: "PowerShell",
    path: "M23.181 2.974c.568 0 .923.463.792 1.035l-3.659 15.982c-.13.572-.697 1.035-1.265 1.035H.819c-.568 0-.923-.463-.792-1.035L3.686 4.009c.13-.572.697-1.035 1.265-1.035zm-8.375 9.346c.251-.394.227-.905-.09-1.243L9.122 5.125c-.38-.404-1.037-.407-1.466-.003-.429.402-.468 1.056-.088 1.46l4.662 4.96v.11l-7.42 5.374c-.45.327-.533.977-.187 1.453.346.476.991.597 1.44.27l8.229-5.91c.28-.196.438-.365.514-.52zm-2.796 4.399a.928.928 0 00-.934.923c0 .51.418.923.934.923h4.433a.928.928 0 00.934-.923.928.928 0 00-.934-.923z",
    // A filled slab, like OpenCode's — pulled in so it doesn't outweigh the
    // agent marks it sits beside in a mixed grid.
    scale: 0.92,
    tone: "text",
  },
  cmd: {
    label: "Command Prompt",
    // Microsoft's console mark — the icon family cmd.exe itself belongs to.
    path: "M8.165 6V3h7.665v3H8.165zm-.5-3H1c-.55 0-1 .45-1 1v2h7.665V3zM23 3h-6.67v3H24V4c0-.55-.45-1-1-1zM0 6.5h24V20c0 .55-.45 1-1 1H1c-.55 0-1-.45-1-1V6.5zM11.5 18c0 .3.2.5.5.5h8c.3 0 .5-.2.5-.5v-1.5c0-.3-.2-.5-.5-.5h-8c-.3 0-.5.2-.5.5V18zm-5.2-4.55l-3.1 3.1c-.25.25-.25.6 0 .8l.9.9c.25.25.6.25.8 0l4.4-4.4a.52.52 0 0 0 0-.8l-4.4-4.4c-.2-.2-.6-.2-.8 0l-.9.9c-.25.2-.25.55 0 .8l3.1 3.1z",
    scale: 0.78,
    tone: "text",
  },
  bash: {
    label: "Bash",
    path: "M21.038,4.9l-7.577-4.498C13.009,0.134,12.505,0,12,0c-0.505,0-1.009,0.134-1.462,0.403L2.961,4.9 C2.057,5.437,1.5,6.429,1.5,7.503v8.995c0,1.073,0.557,2.066,1.462,2.603l7.577,4.497C10.991,23.866,11.495,24,12,24 c0.505,0,1.009-0.134,1.461-0.402l7.577-4.497c0.904-0.537,1.462-1.529,1.462-2.603V7.503C22.5,6.429,21.943,5.437,21.038,4.9z M15.17,18.946l0.013,0.646c0.001,0.078-0.05,0.167-0.111,0.198l-0.383,0.22c-0.061,0.031-0.111-0.007-0.112-0.085L14.57,19.29 c-0.328,0.136-0.66,0.169-0.872,0.084c-0.04-0.016-0.057-0.075-0.041-0.142l0.139-0.584c0.011-0.046,0.036-0.092,0.069-0.121 c0.012-0.011,0.024-0.02,0.036-0.026c0.022-0.011,0.043-0.014,0.062-0.006c0.229,0.077,0.521,0.041,0.802-0.101 c0.357-0.181,0.596-0.545,0.592-0.907c-0.003-0.328-0.181-0.465-0.613-0.468c-0.55,0.001-1.064-0.107-1.072-0.917 c-0.007-0.667,0.34-1.361,0.889-1.8l-0.007-0.652c-0.001-0.08,0.048-0.168,0.111-0.2l0.37-0.236 c0.061-0.031,0.111,0.007,0.112,0.087l0.006,0.653c0.273-0.109,0.511-0.138,0.726-0.088c0.047,0.012,0.067,0.076,0.048,0.151 l-0.144,0.578c-0.011,0.044-0.036,0.088-0.065,0.116c-0.012,0.012-0.025,0.021-0.038,0.028c-0.019,0.01-0.038,0.013-0.057,0.009 c-0.098-0.022-0.332-0.073-0.699,0.113c-0.385,0.195-0.52,0.53-0.517,0.778c0.003,0.297,0.155,0.387,0.681,0.396 c0.7,0.012,1.003,0.318,1.01,1.023C16.105,17.747,15.736,18.491,15.17,18.946z M19.143,17.859c0,0.06-0.008,0.116-0.058,0.145 l-1.916,1.164c-0.05,0.029-0.09,0.004-0.09-0.056v-0.494c0-0.06,0.037-0.093,0.087-0.122l1.887-1.129 c0.05-0.029,0.09-0.004,0.09,0.056V17.859z M20.459,6.797l-7.168,4.427c-0.894,0.523-1.553,1.109-1.553,2.187v8.833 c0,0.645,0.26,1.063,0.66,1.184c-0.131,0.023-0.264,0.039-0.398,0.039c-0.42,0-0.833-0.114-1.197-0.33L3.226,18.64 c-0.741-0.44-1.201-1.261-1.201-2.142V7.503c0-0.881,0.46-1.702,1.201-2.142l7.577-4.498c0.363-0.216,0.777-0.33,1.197-0.33 c0.419,0,0.833,0.114,1.197,0.33l7.577,4.498c0.624,0.371,1.046,1.013,1.164,1.732C21.686,6.557,21.12,6.411,20.459,6.797z",
    scale: 0.92,
    tone: "text",
  },
  zsh: {
    label: "Zsh",
    path: "M11.415 5.038a.58.58 0 0 0-.543.197L.135 18.021a.58.58 0 0 0 .071.814.58.58 0 0 0 .815-.07L11.757 5.979a.58.58 0 0 0-.07-.815.6.6 0 0 0-.272-.126m-8.113.317a3.133 3.133 0 0 0-3.12 3.12 3.13 3.13 0 0 0 3.12 3.119A3.133 3.133 0 0 0 6.42 8.475a3.13 3.13 0 0 0-3.119-3.119m0 1.806a1.3 1.3 0 0 1 1.314 1.313 1.3 1.3 0 0 1-1.314 1.312A1.3 1.3 0 0 1 1.99 8.475a1.3 1.3 0 0 1 1.312-1.314m5.253 5.253a3.13 3.13 0 0 0-3.119 3.119 3.13 3.13 0 0 0 3.12 3.118 3.133 3.133 0 0 0 3.118-3.12 3.133 3.133 0 0 0-3.119-3.118m0 1.805a1.3 1.3 0 0 1 1.313 1.314c0 .735-.577 1.312-1.312 1.312a1.3 1.3 0 0 1-1.314-1.312 1.3 1.3 0 0 1 1.313-1.314m7.201 3.276a.58.58 0 0 0-.578.578.58.58 0 0 0 .578.578h7.666a.58.58 0 0 0 .579-.578.58.58 0 0 0-.579-.578Z",
    scale: 0.9,
    tone: "text",
  },
  // WSL deliberately borrows the generic prompt rather than a distro logo: the
  // shell command says "wsl", not which distribution is behind it, and stamping
  // an Ubuntu mark on a Debian or Alpine root would be a confident lie. The
  // label still says WSL, so the tooltip carries what we actually know.
  wsl: { label: "WSL", path: "", scale: 1, tone: "text", stroke: 2.1 },
  // Generic `>_` prompt for any shell we don't recognise. Hand-drawn rather
  // than borrowed: there is no vendor here to be faithful to, and a stroked
  // glyph matches the pane's other title-bar icons.
  shell: { label: "Terminal", path: "", scale: 1, tone: "text", stroke: 2.1 },
};

/** The `>_` both WSL and the unknown-shell fallback draw. Kept out of the table
 *  so the two entries can't drift apart. */
const PROMPT_PATH = "M6.4 8.2 10.6 12l-4.2 3.8M13.2 16.1h4.6";

/** Both the harness ids the Rust usage poller reports and the CLI binary names
 *  the user can type resolve to the same mark, so the icon appears whichever
 *  signal arrives first. */
const BY_ID: Record<string, AgentBrand> = {
  "claude-code": "claude",
  claude: "claude",
  codex: "codex",
  opencode: "opencode",
  "opencode-cli": "opencode",
  "cursor-agent": "cursor",
  cursor: "cursor",
  gemini: "gemini",
  grok: "grok",
};

/** Resolves a harness id or agent command to the brand whose mark to draw, or
 *  null for a plain shell (and for the agents we have no mark for). */
export function agentBrand(id: string | null | undefined): AgentBrand | null {
  if (!id) return null;
  return BY_ID[id] ?? null;
}

/** Shell binaries we draw a distinct mark for. Everything else falls back to
 *  the generic prompt, so every pane carries an icon. */
const SHELL_BY_NAME: Record<string, ShellBrand> = {
  powershell: "powershell",
  pwsh: "powershell",
  cmd: "cmd",
  bash: "bash",
  sh: "bash",
  "git-bash": "bash",
  zsh: "zsh",
  wsl: "wsl",
};

/** Resolves the configured shell — a bare name or a full path, with or without
 *  `.exe` — to the mark to draw. Never null: an unrecognised shell is still a
 *  terminal, and gets the generic prompt. */
export function shellBrand(shell: string | null | undefined): ShellBrand {
  if (!shell) return "shell";
  const s = shell.toLowerCase();
  // Basename first, so `C:\Program Files\Git\bin\bash.exe` resolves off `bash`
  // rather than off "Program Files" happening to contain something.
  const base = (s.split(/[\\/]/).pop() ?? "").replace(/\.exe$/, "");
  const direct = SHELL_BY_NAME[base];
  if (direct) return direct;
  // Then the whole string, which catches a shell configured with arguments
  // (`wsl.exe -d Ubuntu`). Anchored on word boundaries so a stray "sh" inside a
  // directory name can't claim the pane.
  const m = /\b(pwsh|powershell|cmd|bash|zsh|wsl)\b/.exec(s);
  return m ? SHELL_BY_NAME[m[1]] : "shell";
}

export function markLabel(brand: PaneBrand): string {
  return MARKS[brand].label;
}

/** Gradient ids have to be unique per document — one pane's `url(#…)` would
 *  otherwise resolve to another pane's def. */
let gradSeq = 0;

/** Renders the mark as standalone SVG markup sized to the box CSS gives it. */
export function markSvg(brand: PaneBrand): string {
  const m = MARKS[brand];
  // Scale about the centre of the 24×24 box so the mark stays put as it shrinks.
  const k = m.scale;
  const t = ((1 - k) * 12).toFixed(3);
  const d = m.path || PROMPT_PATH;
  const g = `<g transform="translate(${t} ${t}) scale(${k})"><path d="${d}"/></g>`;

  if (m.stroke) {
    return (
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
      `stroke-width="${m.stroke}" stroke-linecap="round" stroke-linejoin="round" ` +
      `aria-hidden="true">${g}</svg>`
    );
  }

  if (m.tone === "gradient") {
    const id = `agrad${++gradSeq}`;
    return (
      `<svg viewBox="0 0 24 24" fill="url(#${id})" aria-hidden="true">` +
      `<defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">` +
      `<stop offset="0%" stop-color="#4285f4"/>` +
      `<stop offset="52%" stop-color="#9b72cb"/>` +
      `<stop offset="100%" stop-color="#d96570"/>` +
      `</linearGradient></defs>${g}</svg>`
    );
  }

  const fill = (m.tone === "brand" && m.color) || "currentColor";
  return `<svg viewBox="0 0 24 24" fill="${fill}" aria-hidden="true">${g}</svg>`;
}
