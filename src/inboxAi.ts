/** Naming inbox notifications with an AI.
 *
 *  Items sourced straight from a terminal (`raw: true`) carry whatever the
 *  program printed — box-drawing characters, prompt glyphs, half a stack trace.
 *  That reads badly in a notification list, so each one is sent to the same
 *  OpenRouter model delegation uses and comes back as a short name plus a
 *  one-line description of what actually happened.
 *
 *  Everything else in the inbox is text this app wrote, so it gets a name
 *  locally and never costs an API call.
 *
 *  The pass is entirely best-effort: no key, the setting off, or a failed call
 *  all leave the item showing its original text. */

import { invoke } from "@tauri-apps/api/core";
import {
  InboxItem,
  inboxItems,
  KIND_TITLE,
  setInboxAiState,
  setInboxEnricher,
  setInboxSummary,
} from "./inbox";
import { store } from "./store";

/** Terminal tails can be long; the model only needs the shape of the failure,
 *  and this keeps a runaway stack trace from blowing out the request. */
const MAX_INPUT_CHARS = 2000;
/** One in flight at a time — notifications arrive in bursts (a pane dying can
 *  raise several), and there's no reason to hammer the API for a name. */
const queue: InboxItem[] = [];
let running = false;
/** A single OpenRouter blip (timeout, rate limit, a model that ignores the
 *  "reply with only JSON" instruction) shouldn't strand a notification showing
 *  raw terminal text forever — each item gets a couple of automatic retries,
 *  spaced out, before it's given up on. */
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 4000;
const attempts = new WeakMap<InboxItem, number>();

interface Named {
  title: string;
  summary: string;
}

/** Installs the namer as the inbox's enricher. Call once at startup. */
export function startInboxAi(): void {
  setInboxEnricher(enrich);
}

function enrich(item: InboxItem): void {
  if (!item.raw) {
    // App-composed text: it already reads fine, so the name is just the kind
    // and the message becomes the description. Synchronous, no request.
    item.title = KIND_TITLE[item.kind];
    item.summary = item.message;
    item.aiState = "done";
    return;
  }
  if (!aiEnabled()) return;
  item.aiState = "pending";
  queue.push(item);
  void pump();
}

function aiEnabled(): boolean {
  const s = store.state.settings;
  return s.aiInboxSummaries && s.openrouterApiKey.trim().length > 0;
}

async function pump(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const item = queue.shift()!;
      // The setting can be turned off (or the key cleared) while a burst is
      // still queued — drop the rest rather than spending calls on them.
      if (!aiEnabled()) {
        setInboxAiState(item.id, "failed");
        continue;
      }
      try {
        const named = await nameItem(item);
        setInboxSummary(item.id, named.title, named.summary, "done");
      } catch (e) {
        const tries = (attempts.get(item) ?? 0) + 1;
        attempts.set(item, tries);
        if (tries < MAX_ATTEMPTS) {
          console.warn(`Inbox naming failed (attempt ${tries}/${MAX_ATTEMPTS}), retrying:`, e);
          window.setTimeout(() => {
            // Skip the retry if the item was dismissed while it was waiting.
            if (!inboxItems().includes(item)) return;
            queue.push(item);
            void pump();
          }, RETRY_DELAY_MS * tries);
        } else {
          console.warn("Inbox naming failed, giving up:", e);
          setInboxSummary(item.id, "", "", "failed");
        }
      }
    }
  } finally {
    running = false;
  }
}

async function nameItem(item: InboxItem): Promise<Named> {
  const context = [
    `Notification type: ${item.kind === "approval" ? "a program is waiting for the user" : "a program reported an error"}`,
    item.sessionName ? `Session: ${item.sessionName}` : null,
    "Terminal output:",
    item.message.slice(-MAX_INPUT_CHARS),
  ]
    .filter(Boolean)
    .join("\n");

  const raw = await invoke<string>("name_notification", {
    apiKey: store.state.settings.openrouterApiKey.trim(),
    context,
  });
  return parseNamed(raw);
}

/** The model is asked for JSON, but small models sometimes wrap it in a fence
 *  or add a sentence around it — pull the first object out rather than failing
 *  the whole item over formatting. */
function parseNamed(text: string): Named {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in response");
  const parsed = JSON.parse(text.slice(start, end + 1)) as Partial<Named>;
  const title = clean(parsed.title);
  const summary = clean(parsed.summary);
  if (!title || !summary) throw new Error("response missing title or summary");
  return { title: cap(title, 60), summary: cap(summary, 200) };
}

function clean(s: unknown): string {
  return typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "";
}

function cap(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + "…";
}
