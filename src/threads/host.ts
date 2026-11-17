/** Bridge to the Rust process host (src-tauri/src/agent_host.rs). */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface HostEvent {
  id: string;
  kind: "out" | "err" | "exit";
  line?: string;
  code?: number | null;
}

type Handler = (e: HostEvent) => void;
const handlers = new Map<string, Handler>();
let listening: Promise<unknown> | null = null;

function ensureListening(): Promise<unknown> {
  listening ??= listen<HostEvent>("agent-host", (ev) => handlers.get(ev.payload.id)?.(ev.payload));
  return listening;
}

export const host = {
  async attach(id: string, fn: Handler): Promise<void> {
    handlers.set(id, fn);
    await ensureListening();
  },
  detach(id: string): void {
    handlers.delete(id);
  },
  spawn(id: string, cli: string, args: string[], cwd: string, journalSkip: string[]): Promise<number> {
    return invoke<number>("agent_host_spawn", { id, cli, args, cwd, journalSkip });
  },
  write(id: string, msg: unknown): Promise<void> {
    return invoke("agent_host_write", { id, line: JSON.stringify(msg) });
  },
  kill(id: string): Promise<void> {
    return invoke("agent_host_kill", { id });
  },
  running(): Promise<string[]> {
    return invoke<string[]>("agent_host_running").catch(() => []);
  },
  locate(cli: string): Promise<string | null> {
    return invoke<string | null>("agent_host_locate", { cli }).catch(() => null);
  },
  readJournal(id: string): Promise<string> {
    return invoke<string>("thread_journal_read", { id }).catch(() => "");
  },
  append(id: string, record: unknown): Promise<void> {
    return invoke<void>("thread_journal_append", { id, record: JSON.stringify(record) }).catch(() => {});
  },
  deleteJournal(id: string): Promise<void> {
    return invoke<void>("thread_journal_delete", { id }).catch(() => {});
  },
  loadIndex(): Promise<string> {
    return invoke<string>("threads_index_load").catch(() => "");
  },
  saveIndex(json: string): Promise<void> {
    return invoke<void>("threads_index_save", { json });
  },
  gitBranch(cwd: string): Promise<string | null> {
    return invoke<string | null>("thread_git_branch", { cwd }).catch(() => null);
  },
};
