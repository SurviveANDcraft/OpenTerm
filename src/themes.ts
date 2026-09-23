/** A theme is just a set of CSS custom property overrides applied to
 *  `document.documentElement`. All of the app's chrome is already styled
 *  through these variables (see the `:root` block in styles.css), so
 *  switching themes is nothing more than swapping the variable values. */
export interface Theme {
  id: string;
  name: string;
  /** Loose grouping shown as section headers in the theme picker. */
  category: "Minimal" | "Classic" | "Wild";
  /** CSS custom property overrides applied to `:root`. The 13 palette keys are
   *  the app's contract; themes may add extra vars (e.g. `--syn-*` syntax
   *  colors used by the code editor) beyond those. */
  vars: {
    "--bg-app": string;
    "--bg-sidebar": string;
    "--bg-pane": string;
    "--bg-raised": string;
    "--bg-hover": string;
    "--border": string;
    "--border-soft": string;
    "--text": string;
    "--text-dim": string;
    "--text-faint": string;
    "--accent": string;
    "--accent-dim": string;
    "--danger": string;
  } & Record<string, string>;
}

export const THEMES: Theme[] = [
  {
    id: "openterm",
    name: "OpenTerm (Default)",
    category: "Minimal",
    vars: {
      "--bg-app": "#0b0d10",
      "--bg-sidebar": "#10131a",
      "--bg-pane": "#0d1015",
      "--bg-raised": "#171b23",
      "--bg-hover": "#1b2029",
      "--border": "#202634",
      "--border-soft": "#181d26",
      "--text": "#e7eaf0",
      "--text-dim": "#8b93a5",
      "--text-faint": "#5f6878",
      "--accent": "#e8b45a",
      "--accent-dim": "rgba(232, 180, 90, 0.14)",
      "--danger": "#e06c75",
    },
  },
  {
    id: "paper",
    name: "Paper",
    category: "Minimal",
    vars: {
      "--bg-app": "#f7f5f0",
      "--bg-sidebar": "#eeebe3",
      "--bg-pane": "#ffffff",
      "--bg-raised": "#f1eee7",
      "--bg-hover": "#e8e4da",
      "--border": "#ddd7c9",
      "--border-soft": "#e5e0d3",
      "--text": "#2b2820",
      "--text-dim": "#6b6656",
      "--text-faint": "#9a9484",
      "--accent": "#3f6fae",
      "--accent-dim": "rgba(63, 111, 174, 0.12)",
      "--danger": "#c1443c",
      // darker syntax hues for readability on warm paper
      "--syn-keyword": "#8250c4",
      "--syn-func": "#2b6cb8",
      "--syn-const": "#946200",
      "--syn-op": "#1f7a68",
      "--syn-atom": "#b3552e",
      "--syn-string": "#3d7a3d",
      "--syn-link": "#2b6cb8",
      "--syn-invalid": "#b32438",
    },
  },
  {
    id: "slate",
    name: "Slate",
    category: "Minimal",
    vars: {
      "--bg-app": "#16181c",
      "--bg-sidebar": "#1b1e23",
      "--bg-pane": "#181b1f",
      "--bg-raised": "#22262c",
      "--bg-hover": "#272c33",
      "--border": "#2a2f36",
      "--border-soft": "#23272d",
      "--text": "#e4e6ea",
      "--text-dim": "#9198a1",
      "--text-faint": "#63696f",
      "--accent": "#9aa5b1",
      "--accent-dim": "rgba(154, 165, 177, 0.14)",
      "--danger": "#d16a6a",
    },
  },
  {
    id: "mono",
    name: "Mono",
    category: "Minimal",
    vars: {
      "--bg-app": "#000000",
      "--bg-sidebar": "#0a0a0a",
      "--bg-pane": "#050505",
      "--bg-raised": "#141414",
      "--bg-hover": "#1c1c1c",
      "--border": "#2b2b2b",
      "--border-soft": "#202020",
      "--text": "#ffffff",
      "--text-dim": "#a3a3a3",
      "--text-faint": "#6b6b6b",
      "--accent": "#ffffff",
      "--accent-dim": "rgba(255, 255, 255, 0.12)",
      "--danger": "#ff5555",
    },
  },
  {
    id: "ice",
    name: "Ice",
    category: "Minimal",
    vars: {
      "--bg-app": "#eef5fb",
      "--bg-sidebar": "#e2eef9",
      "--bg-pane": "#ffffff",
      "--bg-raised": "#dbe9f5",
      "--bg-hover": "#cfe1f2",
      "--border": "#c3d9ec",
      "--border-soft": "#d3e5f2",
      "--text": "#122b40",
      "--text-dim": "#4c6b83",
      "--text-faint": "#7f97ab",
      "--accent": "#2b8fd6",
      "--accent-dim": "rgba(43, 143, 214, 0.14)",
      "--danger": "#e0554e",
      // darker syntax hues for readability on ice blue
      "--syn-keyword": "#7c3aad",
      "--syn-func": "#1d6fb8",
      "--syn-const": "#8a5c00",
      "--syn-op": "#0f766e",
      "--syn-atom": "#b45309",
      "--syn-string": "#2f7d32",
      "--syn-link": "#1d6fb8",
      "--syn-invalid": "#c0392b",
    },
  },
  {
    id: "nord",
    name: "Nord",
    category: "Classic",
    vars: {
      "--bg-app": "#2e3440",
      "--bg-sidebar": "#3b4252",
      "--bg-pane": "#2e3440",
      "--bg-raised": "#434c5e",
      "--bg-hover": "#4c566a",
      "--border": "#4c566a",
      "--border-soft": "#3b4252",
      "--text": "#eceff4",
      "--text-dim": "#d8dee9",
      "--text-faint": "#81889c",
      "--accent": "#88c0d0",
      "--accent-dim": "rgba(136, 192, 208, 0.16)",
      "--danger": "#bf616a",
    },
  },
  {
    id: "solarized-dark",
    name: "Solarized Dark",
    category: "Classic",
    vars: {
      "--bg-app": "#002b36",
      "--bg-sidebar": "#073642",
      "--bg-pane": "#00252e",
      "--bg-raised": "#0a3b47",
      "--bg-hover": "#0e4757",
      "--border": "#0f4859",
      "--border-soft": "#0a3b47",
      "--text": "#eee8d5",
      "--text-dim": "#93a1a1",
      "--text-faint": "#657b83",
      "--accent": "#b58900",
      "--accent-dim": "rgba(181, 137, 0, 0.16)",
      "--danger": "#dc322f",
    },
  },
  {
    id: "solarized-light",
    name: "Solarized Light",
    category: "Classic",
    vars: {
      "--bg-app": "#fdf6e3",
      "--bg-sidebar": "#eee8d5",
      "--bg-pane": "#fdf6e3",
      "--bg-raised": "#eee8d5",
      "--bg-hover": "#e4ddc4",
      "--border": "#d3cbb7",
      "--border-soft": "#ddd6bd",
      "--text": "#073642",
      "--text-dim": "#586e75",
      "--text-faint": "#93a1a1",
      "--accent": "#268bd2",
      "--accent-dim": "rgba(38, 139, 210, 0.14)",
      "--danger": "#dc322f",
      // solarized accent hues for light background
      "--syn-keyword": "#859900",
      "--syn-func": "#268bd2",
      "--syn-const": "#b58900",
      "--syn-op": "#586e75",
      "--syn-atom": "#cb4b16",
      "--syn-string": "#2aa198",
      "--syn-link": "#268bd2",
      "--syn-invalid": "#dc322f",
    },
  },
  {
    id: "gruvbox",
    name: "Gruvbox Dark",
    category: "Classic",
    vars: {
      "--bg-app": "#1d2021",
      "--bg-sidebar": "#282828",
      "--bg-pane": "#1d2021",
      "--bg-raised": "#3c3836",
      "--bg-hover": "#504945",
      "--border": "#504945",
      "--border-soft": "#3c3836",
      "--text": "#ebdbb2",
      "--text-dim": "#bdae93",
      "--text-faint": "#928374",
      "--accent": "#fe8019",
      "--accent-dim": "rgba(254, 128, 25, 0.16)",
      "--danger": "#fb4934",
    },
  },
  {
    id: "dracula",
    name: "Dracula",
    category: "Classic",
    vars: {
      "--bg-app": "#1e1f29",
      "--bg-sidebar": "#282a36",
      "--bg-pane": "#21222c",
      "--bg-raised": "#343746",
      "--bg-hover": "#3d4052",
      "--border": "#44475a",
      "--border-soft": "#383a4a",
      "--text": "#f8f8f2",
      "--text-dim": "#a9abc1",
      "--text-faint": "#6272a4",
      "--accent": "#ff79c6",
      "--accent-dim": "rgba(255, 121, 198, 0.16)",
      "--danger": "#ff5555",
    },
  },
  {
    id: "onedark",
    name: "One Dark",
    category: "Classic",
    vars: {
      "--bg-app": "#21252b",
      "--bg-sidebar": "#282c34",
      "--bg-pane": "#21252b",
      "--bg-raised": "#2c313a",
      "--bg-hover": "#333842",
      "--border": "#3a3f4b",
      "--border-soft": "#2f333c",
      "--text": "#dcdfe4",
      "--text-dim": "#9da5b4",
      "--text-faint": "#5c6370",
      "--accent": "#61afef",
      "--accent-dim": "rgba(97, 175, 239, 0.16)",
      "--danger": "#e06c75",
    },
  },
  {
    id: "tokyonight",
    name: "Tokyo Night",
    category: "Classic",
    vars: {
      "--bg-app": "#1a1b26",
      "--bg-sidebar": "#16161e",
      "--bg-pane": "#1a1b26",
      "--bg-raised": "#24283b",
      "--bg-hover": "#292e42",
      "--border": "#2f3549",
      "--border-soft": "#20222f",
      "--text": "#c0caf5",
      "--text-dim": "#9aa5ce",
      "--text-faint": "#565f89",
      "--accent": "#7aa2f7",
      "--accent-dim": "rgba(122, 162, 247, 0.16)",
      "--danger": "#f7768e",
    },
  },
  {
    id: "monokai",
    name: "Monokai",
    category: "Classic",
    vars: {
      "--bg-app": "#1e1f1c",
      "--bg-sidebar": "#272822",
      "--bg-pane": "#1e1f1c",
      "--bg-raised": "#34352d",
      "--bg-hover": "#3e3f36",
      "--border": "#49483e",
      "--border-soft": "#34352d",
      "--text": "#f8f8f2",
      "--text-dim": "#cfcfc2",
      "--text-faint": "#75715e",
      "--accent": "#a6e22e",
      "--accent-dim": "rgba(166, 226, 46, 0.16)",
      "--danger": "#f92672",
    },
  },
  {
    id: "rosepine",
    name: "Rosé Pine",
    category: "Classic",
    vars: {
      "--bg-app": "#191724",
      "--bg-sidebar": "#1f1d2e",
      "--bg-pane": "#191724",
      "--bg-raised": "#26233a",
      "--bg-hover": "#2a273f",
      "--border": "#393552",
      "--border-soft": "#26233a",
      "--text": "#e0def4",
      "--text-dim": "#908caa",
      "--text-faint": "#6e6a86",
      "--accent": "#eb6f92",
      "--accent-dim": "rgba(235, 111, 146, 0.16)",
      "--danger": "#e0433d",
    },
  },
  {
    id: "oceandeep",
    name: "Ocean Deep",
    category: "Classic",
    vars: {
      "--bg-app": "#071a24",
      "--bg-sidebar": "#0b2430",
      "--bg-pane": "#081c27",
      "--bg-raised": "#123244",
      "--bg-hover": "#174054",
      "--border": "#1c4257",
      "--border-soft": "#123244",
      "--text": "#dff3f8",
      "--text-dim": "#8fc4d6",
      "--text-faint": "#4f7f92",
      "--accent": "#2ec4b6",
      "--accent-dim": "rgba(46, 196, 182, 0.16)",
      "--danger": "#ef6f6c",
    },
  },
  {
    id: "forest",
    name: "Forest",
    category: "Classic",
    vars: {
      "--bg-app": "#1a1f16",
      "--bg-sidebar": "#202619",
      "--bg-pane": "#1a1f16",
      "--bg-raised": "#2a3320",
      "--bg-hover": "#333f27",
      "--border": "#3a4a2a",
      "--border-soft": "#2a3320",
      "--text": "#e8edd9",
      "--text-dim": "#a8b895",
      "--text-faint": "#6f7d5c",
      "--accent": "#8fbc5a",
      "--accent-dim": "rgba(143, 188, 90, 0.16)",
      "--danger": "#d97757",
    },
  },
  {
    id: "cyberpunk",
    name: "Cyberpunk Neon",
    category: "Wild",
    vars: {
      "--bg-app": "linear-gradient(160deg, #0d0221 0%, #1a0533 45%, #05010d 100%)",
      "--bg-sidebar": "#0e0420",
      "--bg-pane": "#0a0318",
      "--bg-raised": "#180a35",
      "--bg-hover": "#23104a",
      "--border": "#3a1a5c",
      "--border-soft": "#26123f",
      "--text": "#f5f0ff",
      "--text-dim": "#c9a6f7",
      "--text-faint": "#7c5aa8",
      "--accent": "#00f6ff",
      "--accent-dim": "rgba(0, 246, 255, 0.18)",
      "--danger": "#ff2b6d",
    },
  },
  {
    id: "synthwave",
    name: "Synthwave",
    category: "Wild",
    vars: {
      "--bg-app": "linear-gradient(160deg, #1b0c3f 0%, #3a1461 50%, #170a30 100%)",
      "--bg-sidebar": "#1c0f3d",
      "--bg-pane": "#170b33",
      "--bg-raised": "#2c1454",
      "--bg-hover": "#391a68",
      "--border": "#6a2fae",
      "--border-soft": "#2c1454",
      "--text": "#ffe3fb",
      "--text-dim": "#ff9ecf",
      "--text-faint": "#b285d6",
      "--accent": "#ff5fa2",
      "--accent-dim": "rgba(255, 95, 162, 0.18)",
      "--danger": "#ff3860",
    },
  },
  {
    id: "matrix",
    name: "Matrix",
    category: "Wild",
    vars: {
      "--bg-app": "#000600",
      "--bg-sidebar": "#020a02",
      "--bg-pane": "#000400",
      "--bg-raised": "#041604",
      "--bg-hover": "#072007",
      "--border": "#0d3d0d",
      "--border-soft": "#062206",
      "--text": "#b6ffb6",
      "--text-dim": "#4dff4d",
      "--text-faint": "#1f7a1f",
      "--accent": "#00ff41",
      "--accent-dim": "rgba(0, 255, 65, 0.18)",
      "--danger": "#ff3b3b",
    },
  },
  {
    id: "galaxy",
    name: "Galaxy",
    category: "Wild",
    vars: {
      "--bg-app":
        "radial-gradient(circle at 30% 20%, #1b1040 0%, #0a0620 55%, #050312 100%)",
      "--bg-sidebar": "#0d0826",
      "--bg-pane": "#0a0620",
      "--bg-raised": "#191047",
      "--bg-hover": "#221559",
      "--border": "#3a2470",
      "--border-soft": "#191047",
      "--text": "#ede9ff",
      "--text-dim": "#b7a9ec",
      "--text-faint": "#7c6fa8",
      "--accent": "#b388ff",
      "--accent-dim": "rgba(179, 136, 255, 0.18)",
      "--danger": "#ff5d8f",
    },
  },
  {
    id: "bloodmoon",
    name: "Blood Moon",
    category: "Wild",
    vars: {
      "--bg-app": "#0d0303",
      "--bg-sidebar": "#150505",
      "--bg-pane": "#0a0202",
      "--bg-raised": "#240808",
      "--bg-hover": "#331010",
      "--border": "#4a1414",
      "--border-soft": "#240808",
      "--text": "#ffe4e4",
      "--text-dim": "#d68a8a",
      "--text-faint": "#8a4c4c",
      "--accent": "#ff2e2e",
      "--accent-dim": "rgba(255, 46, 46, 0.18)",
      "--danger": "#ff6b4a",
    },
  },
  {
    id: "sunset",
    name: "Sunset",
    category: "Wild",
    vars: {
      "--bg-app": "linear-gradient(160deg, #1a0b12 0%, #3d1220 45%, #742a1f 100%)",
      "--bg-sidebar": "#240f16",
      "--bg-pane": "#1c0a10",
      "--bg-raised": "#3a1520",
      "--bg-hover": "#4a1c28",
      "--border": "#6b2430",
      "--border-soft": "#3a1520",
      "--text": "#ffe9d9",
      "--text-dim": "#f0a875",
      "--text-faint": "#b5714a",
      "--accent": "#ff8a3d",
      "--accent-dim": "rgba(255, 138, 61, 0.18)",
      "--danger": "#ff4d4d",
    },
  },
];

const THEME_MAP: Record<string, Theme> = Object.fromEntries(THEMES.map((t) => [t.id, t]));

export function getTheme(id: string): Theme {
  return THEME_MAP[id] ?? THEMES[0];
}

/** Writes a theme's colors onto :root as CSS custom properties, live-restyling
 *  the whole app (everything already reads these variables). */
export function applyTheme(id: string): void {
  activeTheme = getTheme(id);
  const style = document.documentElement.style;
  for (const [prop, value] of Object.entries(activeTheme.vars)) {
    style.setProperty(prop, value);
  }
  // Text drawn on top of a solid --accent fill (buttons, badges, chips) needs
  // real black/white contrast — a same-hue darkened tint (the old CSS
  // color-mix default) goes near-invisible for light/bright accents like
  // Mono's white or Nord's pale blue.
  const onAccent = luminance(activeTheme.vars["--accent"]) > 0.5 ? "#14151a" : "#ffffff";
  style.setProperty("--on-accent", onAccent);
}

// ---------------------------------------------------------------- terminal colors
//
// xterm renders to canvas/WebGL, so it can't read CSS variables — the terminal
// palette has to be computed from the active theme's values instead. Background,
// foreground, cursor and selection always follow the theme; the 16-color ANSI
// palette switches between a dark-tuned and a light-tuned set based on the
// theme's pane luminance, so light themes (Paper, Ice, Solarized Light) get
// readable terminal colors too.

let activeTheme: Theme = THEMES[0];

/** Perceived luminance of a `#rrggbb` color, 0 (black) → 1 (white). */
function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** `#rrggbb` + alpha → `rgba()` string (xterm accepts CSS colors). */
function withAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 0xff}, ${(n >> 8) & 0xff}, ${n & 0xff}, ${alpha})`;
}

/** ANSI palette tuned for dark pane backgrounds (the app's original set). */
const ANSI_DARK = {
  black: "#1c212b",
  red: "#e06c75",
  green: "#98c379",
  yellow: "#e5c07b",
  blue: "#61afef",
  magenta: "#c678dd",
  cyan: "#56b6c2",
  white: "#b8c0cf",
  brightBlack: "#5a6373",
  brightRed: "#ec8590",
  brightGreen: "#aed49a",
  brightYellow: "#eed09b",
  brightBlue: "#83c2f5",
  brightMagenta: "#d59aeb",
  brightCyan: "#7bd0da",
  brightWhite: "#e6e9ef",
};

/** ANSI palette tuned for light pane backgrounds — saturated mid-tones that
 *  hold 4.5:1-ish contrast against near-white without going neon. */
const ANSI_LIGHT = {
  black: "#3a3f4b",
  red: "#c9403a",
  green: "#3f8a3d",
  yellow: "#9c7115",
  blue: "#2f63b5",
  magenta: "#94419a",
  cyan: "#0e7186",
  white: "#aeb4bf",
  brightBlack: "#6d7480",
  brightRed: "#d9564f",
  brightGreen: "#4f9f4c",
  brightYellow: "#b5851f",
  brightBlue: "#4476cc",
  brightMagenta: "#a855ad",
  brightCyan: "#1588a0",
  brightWhite: "#f5f6f8",
};

/** xterm theme derived from the currently applied app theme. */
export function getTermTheme(): Record<string, string> {
  const v = activeTheme.vars;
  const light = luminance(v["--bg-pane"]) > 0.5;
  return {
    background: v["--bg-pane"],
    foreground: v["--text"],
    cursor: v["--accent"],
    cursorAccent: v["--bg-pane"],
    selectionBackground: withAlpha(v["--text"], light ? 0.22 : 0.32),
    ...(light ? ANSI_LIGHT : ANSI_DARK),
  };
}
