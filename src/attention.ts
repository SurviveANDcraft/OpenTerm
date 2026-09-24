import { invoke } from "@tauri-apps/api/core";
import { store } from "./store";
import { collectLeaves } from "./tree";
import { addInboxItem } from "./inbox";

/** Patterns that show up when a CLI (a shell, or an agent like Claude Code /
 *  opencode) is blocked waiting for the user to answer a confirmation,
 *  approve a permission, or otherwise make a choice before it can continue.
 *
 *  These are deliberately *structural* — the shapes real interactive prompts
 *  take — not conversational phrases. An AI narrating "I'll now ask for
 *  permission to…" or "would you like me to refactor this?" is producing prose,
 *  not blocking on input, and must never trigger the chime. Genuine agent
 *  confirmations render a numbered `❯` menu, which the menu pattern catches. */
const PROMPT_PATTERNS: RegExp[] = [
  /\(y\/n\)/i,
  /\[y\/n\]/i,
  /\[y\/N\]/,
  /\[Y\/n\]/,
  /\(yes\/no\)/i,
  /press enter to continue/i,
  /press any key to continue/i,
  /continue\?\s*$/im,
  /overwrite .{0,40}\?/i,
  /\bproceed\?/i,
];

/** Block-UI selection prompts, kept apart from PROMPT_PATTERNS because they
 *  need a taller window to find. An inline "(y/n)" sits on the very last line,
 *  but a menu is a whole panel: its `❯` marker rides the *first* option, which
 *  an agent asking a four-option question with descriptions pushes a dozen-odd
 *  lines above the footer — well outside PROMPT_LINES, so scanning the same
 *  short window missed real questions entirely. */
const MENU_PATTERNS: RegExp[] = [
  /❯\s*\d+\./, // arrow-key selection menu (Claude Code / opencode / inquirer-style prompts)
  /\?\s*›/, // inquirer.js "? … ›" prompt line
  /\[\?\]/, // inquirer.js prompt marker
];

/** The model-picker menu (Claude Code's `/model`, opencode's equivalent, …)
 *  renders as a numbered `❯` list — structurally identical to a real
 *  confirmation menu, so it would otherwise match the menu pattern above.
 *  But the user opened it themselves (typed `/model` or similar), so there's
 *  nothing to alert them to: they're already looking right at it. Matched
 *  against the whole tail (not just the last few lines) since a long model
 *  list can push the header above the last-lines window that PROMPT_PATTERNS
 *  checks.
 *
 *  This TUI positions its header and help text with cursor-jump escapes
 *  (absolute column placement) rather than literal spaces, so once
 *  stripAnsi() removes those escapes the words butt together with *zero*
 *  characters between them — e.g. "Select model" + "Switch between…" decodes
 *  to "Select modelSwitch between…". A `\bmodel\b` boundary never matches
 *  "modelSwitch" (no boundary between two letters), so this deliberately
 *  does not anchor on word boundaries or require whitespace between the verb
 *  and "model" — just proximity. */
const MODEL_SELECTOR_HEADER = /(?:select|choose|switch|pick)(?:ing)?[\s\S]{0,15}model/i;

/** A CLI's own self-update banner (Codex, Claude Code, npm global installs, …)
 *  — "Codex update available / Version 0.150.1 is available. Press Enter to
 *  continue or select an option." These render with the same "press enter to
 *  continue" shape as a real blocking confirmation, but there's nothing the
 *  user urgently needs to act on: the tool is just announcing a new version is
 *  ready whenever they get to it, same non-urgency as the model picker above. */
const UPDATE_BANNER_HEADER = /(?:new )?version[\s\S]{0,40}\bis available\b/i;

/** Self-navigable settings pickers (Claude Code's theme picker, syntax-theme
 *  picker, and similar) — the user opened these themselves (typed `/theme` or
 *  similar), and their footer literally spells out how to leave: "Enter to
 *  select · Esc to cancel". That's the same "nothing to alert them to, they're
 *  already looking right at it" case as the model picker above, just a
 *  differently-worded footer instead of a differently-worded header — so this
 *  matches on the footer rather than trying to name every picker's title. */
const SETTINGS_PICKER_FOOTER = /enter to select\b[\s\S]{0,40}esc(?:ape)? to cancel/i;

/** A line that is actually *asking* something — the thing that separates an
 *  agent's question from a settings picker wearing the same chrome.
 *
 *  The footer above is not the discriminator people assume it is: Claude Code's
 *  question tool renders the identical "Enter to select · ↑/↓ to navigate · Esc
 *  to cancel" strip, so suppressing on it alone silently ate genuine questions
 *  — no dot, no inbox item, no chime. Settings pickers instruct ("Choose the
 *  option that looks best with your terminal:"); an agent asking for a decision
 *  ends on a question mark. So the footer only suppresses when nothing in view
 *  is posed as a question.
 *
 *  Anchored at end-of-line so a mid-sentence "?" — or a "? for shortcuts"
 *  hint, where the mark leads instead of trailing — doesn't count. */
const QUESTION_LINE = /\?[ \t]*$/m;

/** Patterns that show up when a CLI agent harness (Claude Code, opencode,
 *  Codex CLI, …) or an underlying package/VCS tool has hit a hard failure —
 *  a dropped connection, a rate limit, a crash — rather than a prompt asking
 *  for input. These fire the same chime, since "the terminal needs you" covers
 *  both "it's waiting on you" and "it just died and someone should look."
 *
 *  Harness errors come first since that's the primary target; npm/git/network
 *  failures (the "bad wifi" case) are included too since a flaky connection is
 *  a common root cause behind both. */
const ERROR_PATTERNS: RegExp[] = [
  // --- agent harness failures (Claude Code / opencode / Codex CLI) ---
  /\bAPI Error\b/, // Claude Code's generic failed-request label
  /Request rejected \(\d{3}\)/, // Claude Code 4xx label, e.g. "Request rejected (429)"
  /Repeated 5\d\d .*errors?/i, // Claude Code "Repeated 529 Overloaded errors"
  /\boverloaded_error\b/i,
  /\brate_limit_error\b/i,
  /\bcontext_length_exceeded\b/i,
  /\bAPIConnectionError\b/,
  /TTFB watchdog timeout/i,
  /stream produced no bytes/i,
  /\bserver_error\b.*provider/i, // opencode "server_error" provider failures

  // --- npm / node package managers ---
  /^npm (ERR!|error)\b/im,
  /^error Command failed/im, // yarn
  /^ERR_PNPM_/m,
  /\bcode ERESOLVE\b/,

  // --- network / DNS (the "bad wifi" case) ---
  /\bcode E(NOTFOUND|CONNREFUSED|CONNRESET|TIMEDOUT|AI_AGAIN)\b/,
  /getaddrinfo ENOTFOUND/i,
  /could not resolve host/i,

  // --- git ---
  /^fatal:/im,
];

/** ---- Rendered-screen prompt detection -----------------------------------
 *
 *  Everything above reads the raw PTY byte stream, which works for Claude Code
 *  and plain shells because they print their prompts as ordinary lines. Codex
 *  (ratatui), Gemini CLI and opencode don't: they paint their approval panels
 *  with absolute cursor jumps, so once stripAnsi() drops the escapes the panel
 *  decodes to one long run of glued-together words with no line structure —
 *  and Codex's selection cursor is `›`, not `❯`, so even the glued text never
 *  matched. Those prompts are read off the *rendered* screen instead (the same
 *  xterm buffer the user is looking at), once output has settled.
 *
 *  Every rule here needs structure, never a phrase alone: an agent narrating
 *  "would you like to run this command?" in its reply is prose, and must not
 *  chime. Sourced from the shipped binaries (Codex 0.155, opencode, Gemini
 *  CLI), not guessed. */

/** Rows of the rendered screen inspected. A Codex approval for a long, wrapped
 *  command is a tall panel; its question line sits well above the footer. */
const SCREEN_PROMPT_LINES = 32;

/** Selection-cursor glyphs: Codex / opencode `›`, Claude Code / inquirer `❯`,
 *  Gemini's radio `●`, questionary `»`, plus the triangles some TUIs use.
 *  A bare `>` is deliberately absent — markdown quotes and shell prompts. */
const CURSOR_GLYPHS = "›❯▸▶►»●";

/** The option the cursor sits on: "› 1. Yes, proceed (y)". */
const SELECTED_OPTION = new RegExp(String.raw`^[\s│┃|]*[${CURSOR_GLYPHS}]\s*\d{1,2}[.)]\s+\S`, "u");
/** Any option row, cursor or not: "  2. Yes, and don't ask again …". */
const NUMBERED_OPTION = new RegExp(String.raw`^[\s│┃|]*(?:[${CURSOR_GLYPHS}○◯]\s*)?\d{1,2}[.)]\s+(\S.*)$`, "u");

/** The interaction hint a blocking panel paints under itself:
 *    Codex   "Press enter to confirm or esc to cancel"
 *    Claude  "Enter to select · ↑/↓ to navigate · Esc to cancel"
 *  "esc to interrupt" is intentionally not here — that's the *working* footer. */
const PROMPT_FOOTER =
  /\benter\b[^\n]{0,24}?\bto (?:confirm|submit|select|continue|send|approve|accept|proceed)\b|\besc(?:ape)?\b[^\n]{0,24}?\bto (?:cancel|go back|deny|decline|reject|dismiss)\b/i;

/** Option labels only ever painted by a harness's own approval / question
 *  panels — matched against the text of numbered option rows, never prose. */
const APPROVAL_OPTION_LABEL = new RegExp(
  [
    // Codex
    String.raw`^Yes, proceed\b`,
    String.raw`^Yes, just this once\b`,
    String.raw`^Yes, and (?:don't|do not) ask again\b`,
    String.raw`^Yes, and allow (?:this host|these permissions)\b`,
    String.raw`^Yes, implement this plan\b`,
    String.raw`^Yes, provide the requested info\b`,
    String.raw`^Yes, continue(?: anyway)?\b`,
    String.raw`^No, and tell \S+ what to do differently\b`,
    String.raw`^No, continue without running it\b`,
    String.raw`^No, and block this host\b`,
    String.raw`^No, but continue without it\b`,
    String.raw`^No, stay in Plan mode\b`,
    String.raw`^Run the tool\b`,
    // Gemini CLI
    String.raw`^Allow once\b`,
    String.raw`^Allow for this session\b`,
    String.raw`^Allow always\b`,
    String.raw`^Always allow\b`,
    String.raw`^No, suggest changes\b`,
    String.raw`^Modify with external editor\b`,
    // Claude Code / opencode
    String.raw`^Yes, allow\b`,
    String.raw`^Yes, and don't ask again\b`,
    String.raw`^No, and tell Claude\b`,
    String.raw`^Type your own answer\b`,
    String.raw`^Type something\.?$`,
    String.raw`^Chat about this\b`,
  ].join("|"),
  "i",
);

/** Footer hints that on their own prove a question panel is up — Codex's
 *  request_user_input tool ("enter to submit answer", "… to submit all",
 *  "N unanswered questions") and its MCP elicitation form ("… to navigate
 *  fields"). Only trusted in the last few rows. */
const QUESTION_FOOTER = /\bto submit (?:answer|all)\b|\bunanswered questions?\b|\bto navigate fields\b/i;

/** opencode's permission panel: "△ Permission required", then buttons
 *  "Allow once · Allow always · Reject" (not numbered). */
const OPENCODE_PERMISSION_HEADER = /^[\s△▲⚠!│┃]*Permission required\s*$/i;
const OPENCODE_PERMISSION_BUTTONS = /\bAllow once\b[\s\S]{0,60}\b(?:Allow always|Always allow|Reject)\b/i;

/** Gemini's inline confirmation questions, which its radio list sits under. */
const GEMINI_CONFIRM_QUESTION = /^\s*(?:Allow execution of\b[^\n]*\?|Apply this change\?|Do you want to proceed\?)\s*$/im;

/** Final-failure lines as the harness paints them on screen.
 *
 *    Codex   "■ stream disconnected before completion: …", "■ unexpected
 *            status 401 …", "■ You've hit your usage limit …", "■ Quota
 *            exceeded …", "■ Selected model is at capacity …"
 *    Gemini  "✕ [API Error: …]"
 *
 *  Codex prints *every* error event with that `■` glyph, so the glyph is the
 *  signal — minus the one it also uses when the user pressed Esc themselves
 *  ("Conversation interrupted - tell the model what to do differently"),
 *  which is the user's own doing, not something to alert them about. */
const SCREEN_ERROR_PATTERNS: RegExp[] = [
  /^\s*■\s+(?![^\n]*\binterrupted\b)\S/,
  /^\s*✕\s*\[API Error:/,
];
/** Errors only count near the bottom of the screen — above that they're
 *  scrollback the user has already moved past. */
const SCREEN_ERROR_LINES = 10;

export interface ScreenAttention {
  kind: "prompt" | "error";
  /** Stable identity of what's showing, used to dedup the chime. Built from
   *  the question and option labels only, so moving the cursor between
   *  options (which repaints the panel) doesn't count as a new prompt. */
  sig: string;
  /** Human-ish text for the inbox. */
  message: string;
}

const stripCursor = (l: string): string =>
  l.replace(new RegExp(String.raw`^[\s│┃|]*[${CURSOR_GLYPHS}○◯]?\s*`, "u"), "").trim();

/** Reads a blocking prompt or a final error off a rendered screen, or null.
 *  Pure — exported because it's the piece worth testing directly. */
export function readScreenAttention(screen: string): ScreenAttention | null {
  const lines = screen.split("\n");
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  const win = lines.slice(-SCREEN_PROMPT_LINES);
  const nonEmpty = win.filter((l) => l.trim());
  const footer = nonEmpty.slice(-3).join("\n");
  const text = win.join("\n");

  // Pickers the user opened themselves — nothing to alert them to.
  const vetoed = MODEL_SELECTOR_HEADER.test(text) || UPDATE_BANNER_HEADER.test(text);

  if (!vetoed) {
    // (1) A numbered selection menu with a live cursor.
    const optionIdx: number[] = [];
    win.forEach((l, i) => {
      if (NUMBERED_OPTION.test(l)) optionIdx.push(i);
    });
    const hasCursor = win.some((l) => SELECTED_OPTION.test(l));
    if (hasCursor && optionIdx.length >= 2) {
      const first = optionIdx[0];
      const labels = optionIdx.map((i) => stripCursor(win[i]).replace(/^\d{1,2}[.)]\s+/, ""));
      const knownLabel = labels.some((l) => APPROVAL_OPTION_LABEL.test(l));
      // The question: the topmost "?"-terminated line of the panel above the
      // first option — the header ("Would you like to run the following
      // command?") rather than a "Reason: …?" line under it. The scan stops at
      // a transcript item (Codex "•", a user turn "›") or a box's top edge, so
      // it never reaches up into the conversation.
      let q = -1;
      for (let i = first - 1; i >= Math.max(0, first - 16); i--) {
        const l = win[i].replace(/[\s│┃|]+$/u, "");
        if (/^\s*(?:[•›■✔]\s|╭)/u.test(l)) break;
        if (QUESTION_LINE.test(l) && !/\?\s*for shortcuts/i.test(l)) q = i;
      }
      const hasFooter = PROMPT_FOOTER.test(footer) || QUESTION_FOOTER.test(footer);
      // The options must be the live bottom of the screen, not a list that
      // scrolled up: at most a footer's worth of rows below the last one.
      const tailRows = win.slice(optionIdx[optionIdx.length - 1] + 1).filter((l) => l.trim()).length;
      const atBottom = tailRows <= 6;
      if (atBottom && (hasFooter || knownLabel) && (q >= 0 || knownLabel || QUESTION_FOOTER.test(footer))) {
        const question = q >= 0 ? win[q].trim() : "";
        const top = q >= 0 ? q : Math.max(0, first - 3);
        const block = win
          .slice(top)
          .map((l) => stripCursor(l))
          .filter(Boolean);
        return {
          kind: "prompt",
          sig: [question, ...labels].join(" | ").replace(/\s+/g, " "),
          message: block.join("\n"),
        };
      }
    }

    // (2) A free-text question panel (Codex request_user_input with no
    //     choices, MCP elicitation form) — proven by its footer alone.
    if (QUESTION_FOOTER.test(footer)) {
      const block = nonEmpty.slice(-10).map((l) => l.trim());
      return { kind: "prompt", sig: block.join(" ").replace(/\s+/g, " "), message: block.join("\n") };
    }

    // (3) opencode's permission panel.
    const permIdx = win.findIndex((l) => OPENCODE_PERMISSION_HEADER.test(l));
    if (permIdx >= 0 && OPENCODE_PERMISSION_BUTTONS.test(win.slice(permIdx).join("\n"))) {
      const block = win.slice(permIdx).map((l) => l.trim()).filter(Boolean);
      return { kind: "prompt", sig: block.join(" ").replace(/\s+/g, " "), message: block.join("\n") };
    }

    // (4) Gemini confirmation whose radio list rendered without numbers.
    const gq = GEMINI_CONFIRM_QUESTION.exec(text);
    if (gq && /\b(?:Allow once|Allow for this session|No, suggest changes)\b/i.test(text.slice(gq.index))) {
      const block = text.slice(gq.index).split("\n").map(stripCursor).filter(Boolean);
      return { kind: "prompt", sig: block.join(" ").replace(/\s+/g, " "), message: block.join("\n") };
    }
  }

  // (5) A final error near the bottom — unless the harness is still working
  //     (it's retrying, or has moved on to the next thing).
  const bottom = nonEmpty.slice(-SCREEN_ERROR_LINES);
  if (!bottom.some(isWorkingLine)) {
    for (let i = bottom.length - 1; i >= 0; i--) {
      if (SCREEN_ERROR_PATTERNS.some((re) => re.test(bottom[i]))) {
        const line = bottom[i].trim();
        return { kind: "error", sig: line, message: line };
      }
    }
  }
  return null;
}

/** Every word the harnesses in the new-pane menu paint next to their spinner
 *  while a turn is in flight — the thing a person reads as "it's thinking".
 *
 *  Sourced per harness, not guessed:
 *
 *    Claude Code   all 186 verbs below, lifted verbatim out of the shipped
 *                  binary (the array sits beside the status-line renderer, next
 *                  to "Percolating"), so this is exactly what it can print.
 *    Gemini CLI    the 33 words its WITTY_LOADING_PHRASES open with, read out of
 *                  dist/src/ui/constants/wittyPhrases.js (118 phrases).
 *    Codex CLI     "Working" / "Thinking" — probed its binary for a verb list
 *                  like Claude's; it has none, it relies on the footer instead.
 *    OpenCode      likewise none: it renders "esc interrupt" / "esc again to
 *                  interrupt", which WORKING_LINE_PATTERNS already catches.
 *    Cursor Agent  "Working" status line, plus "Reconnecting…" and friends.
 *    Grok Build    "Thinking", "Writing file…", "Waiting on task output…".
 *
 *  Kept as data rather than a hand-written regex because it is a list that
 *  grows: when a harness invents a new word, adding it here is a one-line
 *  change with no pattern to get wrong.
 *
 *  Split in two tiers because the words differ in how much they prove. These
 *  are distinctive enough to stand on their own — nothing but an agent prints
 *  "Hullaballooing…". */
const LOADING_VERBS: string[] = [
  "Accomplishing", "Actioning", "Actualizing", "Architecting", "Baking", "Beaming", "Beboppin'",
  "Befuddling", "Billowing", "Blanching", "Bloviating", "Boogieing", "Boondoggling", "Booping",
  "Bootstrapping", "Brewing", "Bunning", "Burrowing", "Calculating", "Canoodling",
  "Caramelizing", "Cascading", "Catapulting", "Cerebrating", "Channeling", "Channelling",
  "Choreographing", "Churning", "Clauding", "Coalescing", "Cogitating", "Combobulating",
  "Composing", "Computing", "Concocting", "Considering", "Contemplating", "Cooking", "Crafting",
  "Creating", "Crunching", "Crystallizing", "Cultivating", "Deciphering", "Deliberating",
  "Determining", "Dilly-dallying", "Discombobulating", "Doing", "Doodling", "Drizzling",
  "Ebbing", "Effecting", "Elucidating", "Embellishing", "Enchanting", "Envisioning",
  "Fermenting", "Fiddle-faddling", "Finagling", "Flambéing", "Flibbertigibbeting", "Flowing",
  "Flummoxing", "Fluttering", "Forging", "Forming", "Frolicking", "Frosting", "Gallivanting",
  "Galloping", "Garnishing", "Generating", "Germinating", "Gesticulating", "Gitifying",
  "Grooving", "Gusting", "Harmonizing", "Hashing", "Hatching", "Herding", "Honking",
  "Hullaballooing", "Hyperspacing", "Ideating", "Imagining", "Improvising", "Incubating",
  "Inferring", "Infusing", "Ionizing", "Jitterbugging", "Julienning", "Kneading", "Leavening",
  "Levitating", "Lollygagging", "Manifesting", "Marinating", "Meandering", "Metamorphosing",
  "Misting", "Moonwalking", "Moseying", "Mulling", "Musing", "Mustering", "Nebulizing",
  "Nesting", "Newspapering", "Noodling", "Nucleating", "Orbiting", "Orchestrating", "Osmosing",
  "Perambulating", "Percolating", "Perusing", "Philosophising", "Photosynthesizing",
  "Pollinating", "Pondering", "Pontificating", "Pouncing", "Precipitating", "Prestidigitating",
  "Processing", "Proofing", "Propagating", "Puttering", "Puzzling", "Quantumizing",
  "Razzle-dazzling", "Razzmatazzing", "Recombobulating", "Reticulating", "Roosting",
  "Ruminating", "Sautéing", "Scampering", "Schlepping", "Scurrying", "Seasoning",
  "Shenaniganing", "Shimmying", "Simmering", "Skedaddling", "Sketching", "Slithering",
  "Smooshing", "Sock-hopping", "Spelunking", "Spinning", "Sprouting", "Stewing", "Sublimating",
  "Swirling", "Swooping", "Symbioting", "Synthesizing", "Tempering", "Thinking", "Thundering",
  "Tinkering", "Tomfoolering", "Topsy-turvying", "Transfiguring", "Transmuting", "Twisting",
  "Undulating", "Unfurling", "Unravelling", "Vibing", "Waddling", "Wandering", "Warping",
  "Whatchamacalliting", "Whirlpooling", "Whirring", "Whisking", "Wibbling", "Working",
  "Wrangling", "Zesting", "Zigzagging",
];

/** Loading words that are *also* ordinary English, so they need corroboration.
 *
 *  "Compiling…", "Searching…", "Running…" and "Loading…" are what half the
 *  tooling on a developer's machine prints; keying the dot on them alone would
 *  light it for every webpack build and test runner. They only count when a
 *  spinner glyph is painted immediately before them, which is how Gemini, Grok
 *  and Cursor actually render these — and which a plain log line has no reason
 *  to do. */
const AMBIGUOUS_LOADING_VERBS: string[] = [
  "Applying", "Assembling", "Authenticating", "Buffering", "Charging", "Checking", "Compacting",
  "Compiling", "Connecting", "Converting", "Counting", "Dividing", "Editing", "Engaging",
  "Ensuring", "Entangling", "Fiddling", "Figuring", "Loading", "Looking", "Making", "Mining",
  "Poking", "Polishing", "Preparing", "Reading", "Recalibrating", "Reconnecting", "Rewiring",
  "Rewriting", "Running", "Searching", "Shuffling", "Starting", "Summarizing", "Summoning",
  "Trusting", "Trying", "Untangling", "Updating", "Waiting", "Writing",
];

/** The spinner glyphs these TUIs animate: braille (the ora/ink default), plus
 *  the star and dot marks Claude Code and Codex cycle through. */
const SPINNER_GLYPHS = String.raw`⠀-⣿✻✽✢✳∗※◐◓◑◒◜◝◞◟◴◵◶◷⣾⡿`;

/** A status line built from the verb lists.
 *
 *  Anchored at the start of the line, tolerating the decoration a harness puts
 *  in front of its verb: a spinner glyph, a bullet, a box-drawing edge, an
 *  indent. After the verb it demands proof of liveness — an ellipsis (the
 *  universal "still going" mark), or the "(12s" elapsed counter — so a line of
 *  prose that merely opens with "Considering" cannot trip it. The ambiguous
 *  tier additionally demands the spinner itself.
 *
 *  This is what catches the harnesses whose spinner carries no interrupt hint,
 *  and the moments (the first frames of a turn, a pane too narrow to render the
 *  hint) when a harness that normally shows one hasn't yet. */
const LIVE_SUFFIX = String.raw`[^\n]{0,24}?(?:…|\.\.\.|\(\s*\d{1,4}(?:\.\d)?\s*s\b)`;
const LOADING_VERB_LINE = new RegExp(
  String.raw`^[^\p{L}\p{N}\n]{0,12}(?:${LOADING_VERBS.join("|")})(?!\p{L})${LIVE_SUFFIX}`,
  "iu",
);
const AMBIGUOUS_VERB_LINE = new RegExp(
  String.raw`^[^\p{L}\p{N}\n]{0,10}[${SPINNER_GLYPHS}][^\p{L}\n]{0,4}(?:${AMBIGUOUS_LOADING_VERBS.join("|")})(?!\p{L})${LIVE_SUFFIX}`,
  "iu",
);

/** Lines an agent harness paints *only while a turn is actually in flight* —
 *  the "you can still bail out of this" hint that rides its spinner:
 *
 *    Claude Code  "✻ Percolating… (23s · ↑ 1.4k tokens · esc to interrupt)"
 *    Codex CLI    "Working (12s · Esc to interrupt)"
 *    Gemini CLI   "⠹ Thinking… (esc to cancel, 8s)"
 *    opencode     "working   ctrl+c to interrupt"
 *
 *  This is the signal the running dot keys on, rather than "did bytes arrive".
 *  Raw output means nothing: an echoed keystroke, a shell repainting its
 *  prompt, or an idle TUI blinking its cursor all produce output while nothing
 *  is being generated. An interrupt hint is only ever on screen when the
 *  harness has work it could be interrupted *from*.
 *
 *  Matched line by line against the live screen (see PaneTerm.screenTail),
 *  never against accumulated PTY bytes — a byte tail keeps the hint long after
 *  the turn that printed it ended, which is precisely what made the dot stick
 *  on for panes that were sitting idle at a prompt. */
const WORKING_LINE_PATTERNS: RegExp[] = [
  // "esc to interrupt" and friends. Deliberately tolerant of truncation — these
  // footers are clipped to the pane width, so a narrow split renders
  // "· esc to in…" and a pattern anchored on the whole word never fires.
  /\besc(?:ape)?\b[^\n]{0,16}?\b(?:in|stop|abort|halt|kill|quit)/i,
  /\b(?:interrupt|stop|abort)\b[^\n]{0,12}\(\s*esc/i,
  /\bctrl\+c\b[^\n]{0,20}\b(?:to\s+)?(?:stop|interrupt|cancel|abort)/i,
  // Gemini CLI's wording. "cancel" on its own is ambiguous (a settings picker's
  // "Esc to cancel" footer says nothing about work), so the vetoes below rule
  // the picker case out.
  /\besc(?:ape)?\b[^\n]{0,12}\bcancel\b/i,
  // Claude Code's live thinking line — replaced by the "Baked for 24s" summary
  // the moment the turn lands.
  /\(thinking with [^)\n]{0,24}effort\)/i,
  // Spinner glyph followed by a live elapsed counter: "⠹ Thinking… (8s",
  // "✻ Working (12s". Catches harnesses whose footer omits an interrupt hint.
  /[⠀-⣿✻✽✢✳∗※][^\n]{0,60}\(\s*\d{1,4}(?:\.\d)?s\b/,
  // "✻ Percolating… (23s)", "⠹ Ruminating…", "Working (12s". See LOADING_VERBS.
  LOADING_VERB_LINE,
  AMBIGUOUS_VERB_LINE,
];

/** Evidence that a harness has **sub-agents** (background/parallel agents it
 *  spawned itself) in flight *right now* — a different thing from the harness's
 *  own turn, and the reason the sidebar dot has a second colour.
 *
 *  The thing that makes this hard, and that the first cut of it got wrong: none
 *  of the text a harness paints about agents means "an agent is running".
 *
 *    "⏵⏵ auto mode on (shift+tab to cycle) · ← 2 agents"
 *        A *roster*, not an activity light. It counts the agents that exist in
 *        the session — finished ones included — and sits there unchanged while
 *        the session is idle at its prompt. Matching it lit the dot blue on a
 *        session whose turn had ended minutes ago.
 *
 *    "✳ Waiting for 2 background agents to finish"
 *        True at the instant it is printed, and then it stays in the transcript
 *        forever. Read off a screen, it says nothing about *now*.
 *
 *  So no line here is trusted on its text alone. A candidate only counts once
 *  it has been caught **animating** — a spinner cycling its glyph, an elapsed
 *  counter ticking a second forward. Live TUI chrome moves; dead scrollback
 *  cannot. That single rule is what keeps the blue dot honest, and it is why
 *  the patterns below can afford to be generous: a pattern that over-matches
 *  costs nothing as long as the thing it matched is sitting still.
 */

/** Elapsed-time field as these harnesses print it: "42s", "5m 40s", "1h 2m". */
const ELAPSED = String.raw`(?:\d{1,3}h\s?\d{1,2}m(?:\s?\d{1,2}s)?|(?:\d{1,3}m\s?)?\d{1,3}s)`;

/** (A) A *total*: the harness says how many agents are still out.
 *
 *    Claude Code  "✳ Waiting for 2 background agents to finish"
 *    generic      "Waiting on 3 sub-agents", "2 agents running"
 *
 *  The number is authoritative (finished agents are not in it), but the line
 *  itself may be painted with a static glyph — so it is believed when it moves
 *  on its own *or* when any per-agent claim below is live beside it. */
const AGENT_TOTAL_PATTERNS: RegExp[] = [
  /^[^\p{L}\p{N}\n]{0,8}waiting\s+(?:for|on)\s+(\d{1,3})\s+(?:background\s+|sub-?\s*|parallel\s+)?agents?\b/iu,
  /^[^\p{L}\p{N}\n]{0,8}(\d{1,3})\s+(?:background\s+|sub-?\s*|parallel\s+)?agents?\s+(?:running|active|in progress|working)\b/iu,
];

/** (B) A row of Claude Code's agent roster, painted under the footer:
 *
 *    "● main"
 *    "○ general-purpose  Reading the PROMP… 5m 55s · ↓ 67.9k tokens"
 *
 *  Bullet, agent type, a gap, then an elapsed-time field (optionally clipped
 *  by a narrow pane). Every running row ticks its own clock; a finished row's
 *  clock is frozen — so each row is judged on its own motion, and a roster that
 *  lists done agents next to live ones counts only the live ones. */
const AGENT_ROSTER_ROW = new RegExp(
  String.raw`^\s{0,6}[❯›>]?\s{0,2}[○●◯◉◌◍◎◐◑◒◓·•∙]\s+([\p{L}@][\p{L}\p{N}._:@/-]*)\s{2,}\S[^\n]*?\b${ELAPSED}(?:\s*·|\s*$)`,
  "u",
);

/** (C) Claude Code's parallel inline agents: "● Running 3 Explore agents…". */
const AGENT_GROUP = /^[^\p{L}\n]{0,6}Running\s+(\d{1,3})\s+(?:[\p{L}][\w-]*\s+)?agents?\b/iu;

/** (D) A single inline (foreground) agent: a tool-call header, then its live
 *  body a few rows under it.
 *
 *    "● Explore(Find the auth code)"
 *    "  ⎿  Search(pattern: \"auth\")"
 *    "     +3 more tool uses (ctrl+o to expand)"
 *
 *  Any header counts when the body shows a sub-agent's tool-use tally — a Bash
 *  or Read call never prints one. The looser "⎿ Running…/Initializing…" body
 *  is only trusted under headers that are agent tools by name, since a
 *  backgrounded shell command prints "Running…" too. A "Done (…)" body means
 *  it finished. */
const TOOL_HEADER = /^\s{0,2}[^\p{L}\s⎿│├└]{1,2}\s?([\p{L}][\w:-]*)\(/u;
const AGENT_TOOL_NAME = /^(?:task|agent|explore|plan|general-purpose|[\w:-]*agent[\w-]*)$/i;
const TOOL_USES_BODY = /\+\d+\s+more\s+tool\s+uses?|\b\d+\s+tool\s+uses?\b/i;
const RUNNING_BODY = /⎿[^\n]{0,60}\b(?:running|initializing)\b/i;
const DONE_BODY = /⎿\s*(?:Done|Completed|Finished|Failed|Error|Interrupted)\b/i;

/** One thing on screen that claims agent activity. `key` identifies it across
 *  polls; `text` is what must change for it to count as animating. */
export interface SubagentClaim {
  kind: "total" | "item";
  key: string;
  text: string;
  count: number;
}

/** Reads every sub-agent claim off a rendered screen, without judging whether
 *  any of them is still true — that is pollWorking's job. Exported because it
 *  is the piece worth testing directly. */
export function readSubagentClaims(lines: string[]): SubagentClaim[] {
  const claims: SubagentClaim[] = [];
  const seenKeys = new Map<string, number>();
  const uniq = (k: string): string => {
    const n = seenKeys.get(k) ?? 0;
    seenKeys.set(k, n + 1);
    return n === 0 ? k : `${k}#${n}`;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    let total: RegExpExecArray | null = null;
    for (const re of AGENT_TOTAL_PATTERNS) if ((total = re.exec(line))) break;
    if (total) {
      const n = Number(total[1]);
      if (n > 0) claims.push({ kind: "total", key: uniq("total"), text: line.trim(), count: n });
      continue;
    }

    const row = AGENT_ROSTER_ROW.exec(line);
    if (row) {
      if (row[1].toLowerCase() !== "main") {
        claims.push({ kind: "item", key: uniq(`row:${row[1]}`), text: line.trim(), count: 1 });
      }
      continue;
    }

    const group = AGENT_GROUP.exec(line);
    if (group) {
      const n = Number(group[1]);
      const span = lines.slice(i, i + 1 + Math.min(2 * n + 2, 16));
      if (n > 0) claims.push({ kind: "item", key: uniq("group"), text: span.map((l) => l.trim()).join("\n"), count: n });
      // Its tree rows belong to this claim; don't re-read them as inline agents.
      i += span.length - 1;
      continue;
    }

    const header = TOOL_HEADER.exec(line);
    if (header) {
      const named = AGENT_TOOL_NAME.test(header[1]);
      const body: string[] = [];
      for (let j = i + 1; j <= i + 8 && j < lines.length; j++) {
        if (TOOL_HEADER.test(lines[j])) break;
        body.push(lines[j]);
      }
      const live =
        !body.some((l) => DONE_BODY.test(l)) &&
        (body.some((l) => TOOL_USES_BODY.test(l) && !/\bDone\b/i.test(l)) ||
          (named && body.some((l) => RUNNING_BODY.test(l))));
      if (live) {
        const key = uniq(`task:${line.replace(/^[^\p{L}]*/u, "").slice(0, 80)}`);
        claims.push({ kind: "item", key, text: [line, ...body].map((l) => l.trim()).join("\n"), count: 1 });
        i += body.length;
      }
    }
  }
  return claims;
}

/** How long a claim stays trusted after the last time it was seen to move.
 *
 *  Covers the slowest thing we key on — a once-a-second elapsed counter — plus
 *  room for a repaint that lands between ticks, and doubles as the grace that
 *  keeps the dot steady if the line blinks out of a single frame. */
const SUBAGENT_LIVE_MS = 2600;

/** Screen rows read for sub-agent claims. Taller than the mid-turn check: the
 *  "Waiting for N agents" line sits above the input box, footer and a roster
 *  that grows by a row per agent. */
const SUBAGENT_SCREEN_LINES = 48;
const WORKING_SCREEN_LINES = 14;

/** Vetoes for the patterns above, applied to the *same line*.
 *
 *  A self-navigable picker (Claude Code's /model or /theme, an inquirer list)
 *  paints "Enter to select · ↑/↓ to navigate · Esc to cancel". That trips the
 *  Gemini-style "esc … cancel" pattern while nothing is running at all, and it
 *  stays on screen for as long as the user leaves the picker open — a
 *  permanently stuck dot. Anything offering a *choice* is a menu, not work.
 *
 *  The idle footers are here for the same reason: Claude Code's resting hint
 *  strip ("⏵⏵ accept edits on (shift+tab to cycle)", "? for shortcuts") is
 *  painted while it waits for you to type, the exact opposite of mid-turn. */
const NOT_WORKING_LINE_PATTERNS: RegExp[] = [
  /\bto (?:select|navigate|choose|toggle|cycle|expand|collapse|edit)\b/i,
  /\bshift\s*\+\s*tab\b/i,
  /\?\s*for shortcuts/i,
];

/** How long a pane may go without an interrupt hint being *seen on screen*
 *  before it stops counting as mid-turn.
 *
 *  Short, because the check reads the rendered screen: the hint is either
 *  painted right now or it is not. This grace only absorbs the sub-frame gap
 *  while a TUI clears and redraws its footer — not the multi-second staleness
 *  a byte-stream tail used to need to avoid flickering out mid-turn. */
const WORKING_IDLE_MS = 1200;

/** How long a mid-turn footer stays believed after it was last seen to change.
 *
 *  Same rule the sub-agent claims live by, for the same reason: text alone
 *  proves nothing. A working harness animates its footer — the spinner glyph
 *  cycles several times a second, the elapsed counter ticks every second, the
 *  token tally grows. A line that merely *reads* like a footer but sits still
 *  (a stale row left behind by a repaint, prose that happens to fit a pattern,
 *  a finished turn's leftovers in another pane) is not work, and must not keep
 *  the dot green. Covers one missed tick of the slowest mover — the 1s clock. */
const WORKING_LIVE_MS = 2200;

/** How often the live screen of an active pane is inspected. Fast enough that
 *  the dot lights within a frame or two of a turn starting, cheap enough to run
 *  across every pane (it reads a dozen-odd rows out of xterm's own buffer). */
const WORKING_POLL_MS = 250;

/** A pane whose PTY has been silent longer than this cannot be mid-turn: every
 *  one of these TUIs paints a live elapsed-second counter, so a working harness
 *  repaints at least once a second. Panes past this window are skipped by the
 *  poll entirely, so idle sessions cost nothing. */
const OUTPUT_QUIET_MS = 2500;

function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC sequences
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "") // CSI sequences
    .replace(/\x1b[()][0-9A-Za-z]/g, "") // charset selection
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ""); // other control chars (keep \n \t)
}

export type AttentionListener = (paneId: string, needsAttention: boolean) => void;

const needsAttention = new Map<string, boolean>();
/** Why a pane is flagged — a prompt it's blocked on, or a failure it hit. Both
 *  raise needsAttention; only the sidebar dot's color distinguishes them. */
const attentionKind = new Map<string, "prompt" | "error">();
const decoders = new Map<string, TextDecoder>();
const tails = new Map<string, string>();
const listeners = new Set<AttentionListener>();

/** Panes whose harness is currently mid-turn, and when each was last actually
 *  seen painting an interrupt hint. */
const working = new Map<string, boolean>();
const workingSeenAt = new Map<string, number>();
/** Per pane, the footer text last matched and when it last changed — see
 *  WORKING_LIVE_MS. Kept across frames with no match, so a blink in the redraw
 *  doesn't read as movement when the same text comes back. */
const workingSig = new Map<string, string>();
const workingMovedAt = new Map<string, number>();
/** Panes whose harness currently has sub-agents in flight -> how many. */
const subagents = new Map<string, number>();
/** Per pane, every sub-agent claim recently on screen: its last text, when that
 *  text last *changed* (i.e. was caught animating), and when it was last seen.
 *  A claim that has never been seen to move is scrollback. */
interface ClaimTrack {
  kind: "total" | "item";
  text: string;
  count: number;
  movedAt: number;
  seenAt: number;
}
const subagentClaims = new Map<string, Map<string, ClaimTrack>>();
/** When each pane's PTY last produced any output at all — the cheap gate that
 *  keeps the screen poll off quiet panes. */
const lastOutputAt = new Map<string, number>();

/** Reads the bottom of a pane's *rendered* screen. Injected by main.ts (which
 *  owns the pane registry) so attention.ts stays clear of an import cycle with
 *  terminals.ts. Returns null for ids that are not live terminal panes. */
type ScreenReader = (id: string, count?: number) => string | null;
let readScreen: ScreenReader = () => null;

export function setPaneScreenReader(fn: ScreenReader): void {
  readScreen = fn;
}

/** Timer per pane that confirms a prompt once output has gone quiet. */
const settleTimers = new Map<string, number>();
/** Signature of the prompt we last chimed for, per pane — so a redraw or replay
 *  of the *same* prompt (PTY resize on session switch, window refocus, buffer
 *  repaint) updates the dot silently instead of chiming again. */
const chimedSig = new Map<string, string>();
/** Panes whose flag was raised by the rendered-screen check rather than the
 *  byte stream — only that check may take it back down. */
const screenFlagged = new Set<string>();
/** Per pane, the screen-detected prompt/error the user has already responded
 *  to (typed into the pane while it showed). A rendered screen keeps showing
 *  an error line, or a prompt mid-redraw, after the user acted on it; this
 *  stops that same thing from chiming again on the next settle. */
const screenAcked = new Map<string, string>();

const TAIL_WINDOW = 3000; // chars of recent (decoded, ANSI-stripped) output kept per pane
const PROMPT_LINES = 6; // only the last few non-empty lines are inspected for a live prompt
const MENU_LINES = 18; // a multi-option question panel is tall; its ❯ marker rides the first option
const SETTLE_MS = 400; // output must be silent this long before a prompt counts as "waiting"
const SOUND_COOLDOWN_MS = 4000; // don't machine-gun the chime if several panes prompt in a burst

let lastSoundAt = 0;

export function onAttentionChange(fn: AttentionListener): void {
  listeners.add(fn);
}

export function isPaneWaiting(id: string): boolean {
  return needsAttention.get(id) ?? false;
}

/** True when an agent harness in this pane is mid-turn — actively generating,
 *  not merely printing bytes. See WORKING_LINE_PATTERNS. */
export function isPaneWorking(id: string): boolean {
  return working.get(id) ?? false;
}

/** How many sub-agents the harness in this pane currently has in flight (0 if
 *  none, or if this isn't an agent pane). See readSubagentClaims. */
export function paneSubagentCount(id: string): number {
  return subagents.get(id) ?? 0;
}

/** True when the pane's flag was raised by a failure rather than a prompt. */
export function isPaneErrored(id: string): boolean {
  return (needsAttention.get(id) ?? false) && attentionKind.get(id) === "error";
}

/** Feed newly-arrived PTY output for a pane. A program that is genuinely
 *  waiting on the user has (a) printed a prompt-shaped line and (b) gone silent.
 *  We therefore never react to output the instant it lands — we wait for it to
 *  settle, then confirm the prompt is still showing. This makes streaming agent
 *  prose (which keeps flowing) and prompt redraws (same text again) inert. */
export function feedPaneOutput(id: string, bytes: Uint8Array): void {
  let dec = decoders.get(id);
  if (!dec) {
    dec = new TextDecoder();
    decoders.set(id, dec);
  }
  const chunk = dec.decode(bytes, { stream: true });
  let tail = (tails.get(id) ?? "") + chunk;
  if (tail.length > TAIL_WINDOW) tail = tail.slice(-TAIL_WINDOW);
  tails.set(id, tail);

  // Fresh output arrived, so the program is NOT settled: cancel any pending
  // confirmation. It will be rescheduled below if a prompt is still showing.
  const pending = settleTimers.get(id);
  if (pending !== undefined) {
    clearTimeout(pending);
    settleTimers.delete(id);
  }

  const plain = stripAnsi(tail);
  const promptText = lastLines(plain);
  // Mid-turn detection deliberately does NOT look at this chunk — it reads the
  // rendered screen on a timer instead (see pollWorking). All the byte stream
  // contributes is "this pane is alive right now", which is what decides
  // whether the poll bothers looking at it.
  lastOutputAt.set(id, Date.now());
  const menuText = lastLines(plain, MENU_LINES);
  const asksSomething = QUESTION_LINE.test(menuText);
  const isPrompt =
    (PROMPT_PATTERNS.some((re) => re.test(promptText)) ||
      MENU_PATTERNS.some((re) => re.test(menuText))) &&
    !MODEL_SELECTOR_HEADER.test(plain) &&
    !UPDATE_BANNER_HEADER.test(plain) &&
    !(SETTINGS_PICKER_FOOTER.test(plain) && !asksSomething);
  // Errors can be followed by more output (a stack trace, then a fresh shell
  // prompt), so unlike prompt detection this scans the whole tail window, not
  // just the last few lines.
  const errorLine = isPrompt ? null : findErrorLine(plain);

  if (!isPrompt && !errorLine) {
    // Nothing prompt-shaped in the byte stream. A TUI that paints with cursor
    // jumps (Codex, Gemini, opencode) may still be showing one, which only the
    // rendered screen can tell — so check that once output settles. Until then,
    // a flag the screen raised stays up: its panel repaints (cursor moves, a
    // ticking clock) must not blink the dot off and on.
    if (!screenFlagged.has(id)) {
      setAttention(id, false);
      chimedSig.delete(id);
    }
    settleTimers.set(
      id,
      window.setTimeout(() => {
        settleTimers.delete(id);
        settleFromScreen(id);
      }, SETTLE_MS),
    );
    return;
  }

  // A prompt or error is showing. Wait for the output to go quiet before
  // trusting it: if more bytes arrive within SETTLE_MS, this timer is
  // cancelled above and the program is still working, not waiting/dead.
  const sig = isPrompt ? promptText.replace(/\s+/g, " ").trim() : errorLine!;
  settleTimers.set(
    id,
    window.setTimeout(() => {
      settleTimers.delete(id);
      screenFlagged.delete(id);
      raise(id, isPrompt ? "prompt" : "error", sig, sig);
    }, SETTLE_MS),
  );
}

/** Flags a pane and — the first time this particular prompt/error is seen —
 *  chimes, flashes the taskbar and files an inbox item. */
function raise(id: string, kind: "prompt" | "error", sig: string, message: string): void {
  // Blocked on a question, or dead: either way it is not mid-turn any more.
  setWorking(id, false);
  setAttention(id, true, kind);
  if (chimedSig.get(id) === sig) return;
  chimedSig.set(id, sig);
  playChime();
  if (store.state.settings.taskbarFlash) void invoke("flash_taskbar_icon");
  const session = store.state.sessions.find((s) => collectLeaves(s.tree).includes(id));
  addInboxItem({
    kind: kind === "prompt" ? "approval" : "error",
    message,
    // Straight off the terminal — box-drawing, prompt glyphs and all. The AI
    // namer turns this into something readable.
    raw: true,
    sessionId: session?.id,
    sessionName: session?.name,
    paneId: id,
  });
}

/** The settled-output check against the rendered screen (see
 *  readScreenAttention). Raises the flag for a panel the byte stream couldn't
 *  see, and takes it back down once that panel is gone. */
function settleFromScreen(id: string): void {
  const screen = readScreen(id, SCREEN_PROMPT_LINES);
  const hit = screen ? readScreenAttention(screen) : null;
  const acked = screenAcked.get(id);
  if (hit && hit.sig !== acked) {
    screenFlagged.add(id);
    raise(id, hit.kind, hit.sig, hit.message);
    return;
  }
  // What the user already responded to is gone from the screen: forget it, so
  // the same prompt coming back later counts as new.
  if (!hit) screenAcked.delete(id);
  if (screenFlagged.delete(id)) {
    setAttention(id, false);
    chimedSig.delete(id);
  }
}

/** The last few non-empty lines of `plain`, joined back with newlines. A live
 *  prompt sits at the very end of the output with the cursor on it; matching the
 *  whole scrollback would fire on prompt-shaped text that scrolled past long
 *  ago. A handful of lines is enough to cover multi-line menu UIs. */
function lastLines(plain: string, count = PROMPT_LINES): string {
  const lines = plain.split("\n");
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.slice(-count).join("\n");
}

/** The most recent line in `plain` matching an ERROR_PATTERN, or null. Used
 *  both to decide whether to chime and as the dedup signature — scanning line
 *  by line (rather than matching the whole blob) keeps the signature stable
 *  even as unrelated output keeps sliding through the tail window after it. */
function findErrorLine(plain: string): string | null {
  const lines = plain.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (ERROR_PATTERNS.some((re) => re.test(line))) return line.trim();
  }
  return null;
}

/** Call when the user sends input to a pane — they're responding, so clear the
 *  flag immediately and reset dedup state (the next prompt, even an identical
 *  one, should chime again). */
export function clearPaneAttention(id: string): void {
  if (screenFlagged.delete(id)) {
    const sig = chimedSig.get(id);
    if (sig) screenAcked.set(id, sig);
  }
  tails.delete(id);
  chimedSig.delete(id);
  const pending = settleTimers.get(id);
  if (pending !== undefined) {
    clearTimeout(pending);
    settleTimers.delete(id);
  }
  setAttention(id, false);
}

/** Call when a pane is torn down, to stop tracking it. */
export function forgetPane(id: string): void {
  const hadStatus = isPaneWaiting(id) || isPaneWorking(id) || paneSubagentCount(id) > 0;
  needsAttention.delete(id);
  attentionKind.delete(id);
  working.delete(id);
  workingSeenAt.delete(id);
  workingSig.delete(id);
  workingMovedAt.delete(id);
  subagents.delete(id);
  subagentClaims.delete(id);
  lastOutputAt.delete(id);
  decoders.delete(id);
  tails.delete(id);
  chimedSig.delete(id);
  screenFlagged.delete(id);
  screenAcked.delete(id);
  const pending = settleTimers.get(id);
  if (pending !== undefined) {
    clearTimeout(pending);
    settleTimers.delete(id);
  }
  // Session dots cache aggregate pane status; teardown must invalidate them too.
  if (hadStatus) {
    for (const fn of listeners) fn(id, false);
  }
}

function setAttention(id: string, waiting: boolean, kind?: "prompt" | "error"): void {
  const prev = needsAttention.get(id) ?? false;
  const prevKind = attentionKind.get(id);
  if (waiting) attentionKind.set(id, kind!);
  else attentionKind.delete(id);
  // A pane that slides straight from a prompt into an error stays flagged the
  // whole time, but the dot has to change color — so the kind is part of what
  // counts as "changed", not just the boolean.
  if (waiting === prev && kind === prevKind) return;
  needsAttention.set(id, waiting);
  for (const fn of listeners) fn(id, waiting);
}

/** Flips a pane's mid-turn flag, notifying listeners on the edges only. */
function setWorking(id: string, busy: boolean): void {
  const prev = working.get(id) ?? false;
  if (busy) workingSeenAt.set(id, Date.now());
  else workingSeenAt.delete(id);
  if (busy === prev) return;
  working.set(id, busy);
  for (const fn of listeners) fn(id, needsAttention.get(id) ?? false);
}

/** Flips a pane's sub-agent count, notifying listeners when it changes.
 *
 *  The count itself is part of what counts as "changed" (not just zero vs.
 *  non-zero) so the sidebar tooltip can say "2 sub-agents" and stay honest as
 *  agents finish one by one. */
function setSubagents(id: string, count: number): void {
  const prev = subagents.get(id) ?? 0;
  if (count === prev) return;
  if (count > 0) subagents.set(id, count);
  else subagents.delete(id);
  for (const fn of listeners) fn(id, needsAttention.get(id) ?? false);
}

/** True when this line of a live screen is a harness's mid-turn footer. */
export function isWorkingLine(line: string): boolean {
  if (!line.trim()) return false;
  if (NOT_WORKING_LINE_PATTERNS.some((re) => re.test(line))) return false;
  return WORKING_LINE_PATTERNS.some((re) => re.test(line));
}

/** Inspects the live screen of every pane that could plausibly be mid-turn and
 *  reconciles the running flag with what is actually painted there.
 *
 *  A pane qualifies if its PTY spoke recently, or if it is currently flagged
 *  (so a raised flag always gets a chance to be taken back down). Everything
 *  else — the dozens of idle shells a big layout accumulates — costs one map
 *  lookup and is dropped from the candidate set entirely. */
function pollWorking(): void {
  const now = Date.now();
  const candidates = new Set<string>([
    ...lastOutputAt.keys(),
    ...working.keys(),
    ...subagents.keys(),
    ...subagentClaims.keys(),
  ]);
  for (const id of candidates) {
    const spokeRecently = now - (lastOutputAt.get(id) ?? 0) < OUTPUT_QUIET_MS;
    const flagged = working.get(id) ?? false;
    const tracking = (subagents.get(id) ?? 0) > 0 || subagentClaims.has(id);
    if (!spokeRecently && !flagged && !tracking) {
      lastOutputAt.delete(id);
      continue;
    }
    const tall = readScreen(id, SUBAGENT_SCREEN_LINES) ?? "";
    const tallLines = tall ? tall.split("\n") : [];
    const lines = tallLines.slice(-WORKING_SCREEN_LINES);

    // Blocked on a question, or sitting on a failure, is the opposite of
    // working — and outranks whatever is still painted on screen.
    if (!needsAttention.get(id) && footerIsLive(id, lines.filter(isWorkingLine).join("\n"), now)) {
      setWorking(id, true);
    } else if (flagged && now - (workingSeenAt.get(id) ?? 0) >= WORKING_IDLE_MS) {
      setWorking(id, false);
    }

    // Sub-agents are read from the same screen, but deliberately NOT gated on
    // needsAttention: background agents keep running while their parent sits
    // at a prompt waiting for you.
    setSubagents(id, liveSubagentCount(id, readSubagentClaims(tallLines), now));
  }
}

/** True when `sig` (every mid-turn footer line on screen right now) is both
 *  present and has been caught changing within WORKING_LIVE_MS.
 *
 *  A first sighting is only recorded, never believed: the dot lights on the
 *  next tick of the spinner (a fraction of a second into a real turn), while a
 *  static look-alike never lights it at all. */
function footerIsLive(id: string, sig: string, now: number): boolean {
  if (!sig) return false;
  const prev = workingSig.get(id);
  workingSig.set(id, sig);
  if (prev !== undefined && prev !== sig) workingMovedAt.set(id, now);
  return now - (workingMovedAt.get(id) ?? 0) < WORKING_LIVE_MS;
}

/** Folds this poll's claims into the pane's tracked ones and returns how many
 *  sub-agents are provably running right now.
 *
 *  Each claim is believed only once it has been caught moving: the first time
 *  it appears only its text is recorded, which is all a static scrollback line
 *  will ever do. A live one repaints (ticking clock, blinking glyph, growing
 *  tool tally) and a later poll sees the change.
 *
 *  A "Waiting for N agents" total wins when believed — its count excludes
 *  finished agents. It is believed when it moves itself, or when its glyph is
 *  static but a roster row or inline agent beside it is visibly ticking.
 *  Otherwise the count is the sum of the individually live items. */
function liveSubagentCount(id: string, claims: SubagentClaim[], now: number): number {
  let tracked = subagentClaims.get(id);
  if (!tracked) {
    if (claims.length === 0) return 0;
    tracked = new Map();
    subagentClaims.set(id, tracked);
  }
  for (const c of claims) {
    const prev = tracked.get(c.key);
    const movedAt = prev && prev.text !== c.text ? now : (prev?.movedAt ?? 0);
    tracked.set(c.key, { kind: c.kind, text: c.text, count: c.count, movedAt, seenAt: now });
  }

  let total = 0;
  let totalLive = false;
  let items = 0;
  for (const [key, t] of tracked) {
    // Absent for longer than a blink: gone (finished, collapsed, scrolled off).
    if (now - t.seenAt >= SUBAGENT_LIVE_MS) {
      tracked.delete(key);
      continue;
    }
    const live = now - t.movedAt < SUBAGENT_LIVE_MS;
    if (t.kind === "total") {
      total = Math.max(total, t.count);
      if (live) totalLive = true;
    } else if (live) {
      items += t.count;
    }
  }
  if (tracked.size === 0) subagentClaims.delete(id);

  if (total > 0 && (totalLive || items > 0)) return total;
  return items;
}

window.setInterval(pollWorking, WORKING_POLL_MS);

function playChime(): void {
  if (!store.state.settings.soundNotifications) return;
  const now = Date.now();
  if (now - lastSoundAt < SOUND_COOLDOWN_MS) return;
  lastSoundAt = now;
  void invoke("play_attention_sound", { path: store.state.settings.soundPath });
}
