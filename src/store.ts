import { invoke } from "@tauri-apps/api/core";
import {
  AppState,
  DEFAULT_KEYBINDS,
  DEFAULT_DICTATION,
  DEFAULT_SETTINGS,
  Session,
  Settings,
} from "./types";
import { pruneExternalLeaves } from "./tree";
import { addInboxItem } from "./inbox";

/** UTC day key, matching how the Rust side names daily snapshot files. */
function utcDayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

class Store {
  state: AppState = {
    sessions: [],
    activeSessionId: null,
    settings: structuredClone(DEFAULT_SETTINGS),
  };

  private timer: number | undefined;
  /** Set when boot had to restore from a backup because state.json was
   *  missing or corrupt — surfaced once as an inbox notice. */
  private recoveredFromBackup = false;
  /** No state.json and no usable backup: this is the very first launch on this
   *  machine. The only reliable first-run signal we have — settings alone can't
   *  tell a fresh install from an upgrade. */
  private firstRun = false;
  private lastBackupNoticeDay = "";
  private introNoticeShown = false;
  private warnedSaveFailure = false;
  private suspended = false;

  async load(): Promise<void> {
    try {
      const res = await invoke<{
        json: string | null;
        recoveredFromBackup: boolean;
      }>("load_state");
      this.recoveredFromBackup = !!res.recoveredFromBackup;
      const raw = res.json;
      if (!raw) {
        this.firstRun = true;
        return;
      }
      const parsed = JSON.parse(raw) as Partial<AppState>;
      const settings: Settings = {
        ...structuredClone(DEFAULT_SETTINGS),
        ...(parsed.settings ?? {}),
        keybinds: { ...DEFAULT_KEYBINDS, ...(parsed.settings?.keybinds ?? {}) },
        dictation: { ...structuredClone(DEFAULT_DICTATION), ...(parsed.settings?.dictation ?? {}) },
      };
      // Embedded external terminals can't be restored (their HWND is gone), so
      // drop those leaves; a session left with nothing but externals disappears.
      const sessions: Session[] = (Array.isArray(parsed.sessions) ? parsed.sessions : [])
        .map((s) => {
          const tree = pruneExternalLeaves(s.tree);
          return tree ? { ...s, tree } : null;
        })
        .filter((s): s is Session => s !== null);
      this.state = {
        sessions,
        activeSessionId: parsed.activeSessionId ?? null,
        settings,
      };
    } catch (e) {
      console.error("Failed to load state, starting fresh:", e);
    }
    if (this.recoveredFromBackup) {
      addInboxItem({
        kind: "backup",
        message:
          "Your main data file was unreadable, so everything was restored " +
          "from the most recent automatic backup. Nothing was lost.",
      });
    }
  }

  isFirstRun(): boolean {
    return this.firstRun;
  }

  /** Stops all further writes to state.json. Used right before a backup restore
   *  reloads the app: the teardown that follows would otherwise persist a
   *  half-dismantled state over the file we just restored. Irreversible on
   *  purpose — the only way out is the reload. */
  suspend(): void {
    this.suspended = true;
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = undefined;
  }

  save(immediate = false): void {
    if (this.suspended) return;
    if (this.timer) window.clearTimeout(this.timer);
    if (immediate) {
      void this.flush();
    } else {
      this.timer = window.setTimeout(() => void this.flush(), 400);
    }
  }

  private async flush(): Promise<void> {
    try {
      const res = await invoke<{ dailyBackupCreated: boolean }>("save_state", {
        json: JSON.stringify(this.state),
      });
      // Subtle, low-frequency reassurance that backups are happening — one
      // intro item per run (only if no daily snapshot fired with it), then at
      // most one per calendar day. Never urgent-colored; just visible.
      if (!this.introNoticeShown) {
        this.introNoticeShown = true;
        if (!res?.dailyBackupCreated) {
          addInboxItem({
            kind: "backup",
            message:
              "Automatic backups are on. Your last 30 changes are snapshotted " +
              "locally, plus one per day (last 7 days kept). Browse and restore " +
              "them from Settings → Backups.",
          });
        }
      }
      if (res?.dailyBackupCreated) {
        const day = utcDayKey();
        if (day !== this.lastBackupNoticeDay) {
          this.lastBackupNoticeDay = day;
          addInboxItem({
            kind: "backup",
            message: `Daily backup saved (${day}) — your sessions and settings have a snapshot from today.`,
          });
        }
      }
    } catch (e) {
      console.error("Failed to save state:", e);
      if (!this.warnedSaveFailure) {
        this.warnedSaveFailure = true;
        addInboxItem({
          kind: "error",
          message:
            "Could not write your session data to disk. Changes are still in " +
            "memory — they will be retried on the next save.",
        });
      }
    }
  }
}

export const store = new Store();
