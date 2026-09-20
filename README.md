# OpenTerm

**A vibe coding workspace for Windows.**

Run several AI agents at once without losing track of any of them. OpenTerm
keeps every project, terminal and agent session in one window — named
workspaces in a sidebar, each one a grid of terminals you can split, fold and
rearrange, driven entirely from the keyboard. Close the app, reopen it, and
everything is exactly where you left it.

Windows · free · updates itself. Website and documentation:
**[openterm.app](https://www.openterm.app)**.

### [⬇ Download the latest release](https://github.com/SurviveANDcraft/OpenTerm/releases/latest)

> **OpenTerm is out, and this is its first public release — a beta.** It is
> stable enough for daily use, it is what I use all day, but you may hit rough
> edges. Bug reports are very welcome:
> [open an issue](https://github.com/SurviveANDcraft/OpenTerm/issues).

---

## Why it exists

Vibe coding means living in terminals. Two or three agents per project, one more
watching a dev server, another for git, and a separate window for every repo you
touch. They scroll away, you lose track of which agent asked you a question
twenty minutes ago, and every restart means setting the whole thing up again.

OpenTerm makes that pile into a workspace.

## What you get

**Sessions and panes.** One named session per project, rooted in its folder.
Split any pane into rows or columns, drag panes around, zoom one to full screen,
fold the ones you're not watching. Type `OpenTerm` into any Explorer address bar
— or right-click a folder — and it opens as a session.

**It tells you when an agent needs you.** OpenTerm watches your terminals for
approval prompts, errors and finished work, and collects them in an inbox with
the taskbar blinking. You can look away from a long run without losing the
moment it stops.

**Usage and costs.** Live token usage and spend per pane and per session for
Claude Code, Codex and friends, with your plan's limits and how close you are to
them.

**Dictation, anywhere.** Hold a shortcut, talk, and your words land in whatever
is focused — a terminal, an agent prompt, any other app on your machine. Off
until you turn it on, and it needs your own API key.

**A browser that reports back.** Open a browser pane next to your code. It
captures console output and network requests, and hands them to an agent as
context with one drag — no copying stack traces out of DevTools.

**Files beside your terminals.** A file tree for the session folder, plus file
panes that dock into the grid: Markdown, code with syntax highlighting, PDFs,
images, spreadsheets and Word documents.

**A map of your repo.** Branches, commits, contributors and what's changed,
without leaving the window.

**Tasks and delegation.** A per-session task list, and a way to hand a task
straight to an agent in a new pane with its files and notes attached.

**Nothing is lost.** Sessions, layouts and settings save continuously and are
snapshotted on every change. Settings → Backups lets you browse those snapshots,
see what each one holds and restore it — and that restore is itself undoable.

**Yours, locally.** Everything lives on your machine. Nothing is sent anywhere
unless you turn on a feature that needs it (dictation, AI naming) and supply
your own API key.

## Updates

OpenTerm checks for new versions on startup and installs them for you. Every
update is cryptographically signed and refused if the signature doesn't match,
so only builds from this repo can reach an installed copy.

## Shortcuts

Everything is keyboard-first and every shortcut is rebindable in Settings.
`Ctrl+/` shows the full cheat sheet in the app.

| | |
|---|---|
| New session | `Ctrl+Shift+T` |
| Jump to session 1–9 | `Alt+1…9` |
| Split right / down | `Ctrl+Shift+E` / `Ctrl+Shift+O` |
| Focus / resize pane | `Ctrl+Arrows` / `Ctrl+Alt+Arrows` |
| Zoom / fold pane | `Ctrl+Shift+Z` / `Ctrl+Shift+D` |
| Find in terminal | `Ctrl+Shift+F` |
| Cheat sheet · Settings | `Ctrl+/` · `Ctrl+,` |

## Links

- [openterm.app](https://www.openterm.app) — website
- [Documentation](https://www.openterm.app/documentation) — every feature, and every shortcut
- [Releases](https://github.com/SurviveANDcraft/OpenTerm/releases) — downloads and changelog

## Install

1. Open the [latest release](https://github.com/SurviveANDcraft/OpenTerm/releases/latest).
2. Download `OpenTerm_<version>_x64-setup.exe` and run it.
3. Windows SmartScreen will warn about an unrecognised publisher — choose
   **More info → Run anyway**.

Windows 10 or 11, 64-bit. Nothing else to install: WebView2 is already part of
Windows 11, and the installer fetches it on 10 if it's missing.

## Feedback

Found a bug, or something felt wrong?
[Open an issue](https://github.com/SurviveANDcraft/OpenTerm/issues) — during the
beta that's the fastest way to get it fixed.

## License

OpenTerm is **source-available**, not open source, under the
[Elastic License 2.0](LICENSE.txt) — most notably you may not offer OpenTerm to
third parties as a hosted or managed service, strip its notices, or tamper with
license-key functionality.

Bundled third-party components keep their own permissive licenses; see
[NOTICE.md](NOTICE.md).
