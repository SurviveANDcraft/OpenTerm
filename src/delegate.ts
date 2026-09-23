/** Task delegation: turning a task into an agent-ready prompt.
 *
 *  The raw prompt is composed locally from the task's fields; optionally it's
 *  then "enhanced" by an AI (OpenRouter, deepseek/deepseek-v4-flash) that
 *  clarifies intent and flags questions the executing agent should ask.
 *
 *  NOTE FOR THE FUTURE: `enhancePrompt` is deliberately the only place that
 *  knows *how* prompts get AI-enhanced. When delegation becomes part of a paid
 *  subscription, swap its body for a call to our own backend (which holds the
 *  model key and validates the subscription) — nothing else changes. */

import { invoke } from "@tauri-apps/api/core";
import { DELEGATION_AGENTS, DelegationAgent, Task } from "./types";

/** Plain-text prompt handed to the executing agent over bracketed paste —
 *  no markdown fences, agent CLIs read raw stdin. */
export function buildDelegationPrompt(task: Task): string {
  const parts: string[] = [];
  parts.push(`# Task: ${task.title || "Untitled task"}`);
  if (task.description.trim()) {
    parts.push(task.description.trim());
  }
  if (task.subtasks.length) {
    parts.push(
      "Subtasks:\n" + task.subtasks.map((s) => `- [${s.done ? "x" : " "}] ${s.title}`).join("\n")
    );
  }
  if (task.files.length) {
    parts.push(
      "Attached files (absolute paths):\n" + task.files.map((f) => `- ${f}`).join("\n")
    );
  }
  return parts.join("\n\n");
}

/** Sends the raw prompt to OpenRouter (via the `enhance_prompt` Rust command)
 *  and returns the clarified version. Routed through the backend so there's no
 *  CORS/origin exposure in the webview, and one place to swap in a subscription
 *  backend later. Throws on any failure — callers fall back to the raw text. */
export async function enhancePrompt(raw: string, apiKey: string): Promise<string> {
  const text = await invoke<string>("enhance_prompt", { apiKey, prompt: raw });
  const trimmed = text.trim();
  if (!trimmed) throw new Error("OpenRouter returned an empty response");
  return trimmed;
}

export function agentCommand(agent: DelegationAgent): string {
  return DELEGATION_AGENTS.find((a) => a.id === agent)?.command ?? agent;
}

export function agentLabel(agent: DelegationAgent): string {
  return DELEGATION_AGENTS.find((a) => a.id === agent)?.label ?? agent;
}
