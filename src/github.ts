/** GitHub issues for a session's folder, via the `gh` CLI (see
 *  src-tauri/src/github.rs). `gh` holds the login, so nothing here ever sees a
 *  token — a user who hasn't run `gh auth login` just gets `state: "auth"`. */

import { invoke } from "@tauri-apps/api/core";

export interface GhStatus {
  state: "ok" | "missing" | "auth" | "no-repo" | "error";
  repo?: string | null;
  url?: string | null;
  login?: string | null;
  message?: string | null;
}

export interface GhUser {
  login: string;
  name?: string;
}

export interface GhLabel {
  name: string;
  /** Hex without the leading '#', as GitHub stores it. */
  color: string;
  description?: string;
}

export interface GhComment {
  author: GhUser | null;
  body: string;
  createdAt: string;
  url?: string;
}

export interface GhIssue {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED";
  /** "COMPLETED" | "NOT_PLANNED" | "REOPENED" | "" */
  stateReason: string;
  labels: GhLabel[];
  assignees: GhUser[];
  author: GhUser | null;
  comments: GhComment[];
  createdAt: string;
  updatedAt: string;
  url: string;
  /** Only present on `ghIssueView` results. */
  body?: string;
}

export type IssueFilter = "open" | "closed" | "mine";
export type IssueStateAction = "close" | "close-not-planned" | "reopen";

export const ghStatus = (cwd: string) => invoke<GhStatus>("gh_status", { cwd });

export const ghIssueList = (cwd: string, filter: IssueFilter) =>
  invoke<GhIssue[]>("gh_issue_list", {
    cwd,
    state: filter === "closed" ? "closed" : "open",
    mine: filter === "mine",
  });

export const ghIssueView = (cwd: string, number: number) =>
  invoke<GhIssue>("gh_issue_view", { cwd, number });

export const ghIssueSetState = (cwd: string, number: number, action: IssueStateAction) =>
  invoke<void>("gh_issue_set_state", { cwd, number, action });

export const ghIssueComment = (cwd: string, number: number, body: string) =>
  invoke<void>("gh_issue_comment", { cwd, number, body });

export const ghIssueCreate = (cwd: string, title: string, body: string) =>
  invoke<string>("gh_issue_create", { cwd, title, body });

export const ghIssueAssignMe = (cwd: string, number: number, assign: boolean) =>
  invoke<void>("gh_issue_assign_me", { cwd, number, assign });

/** Turns `gh`'s stderr into one readable line for an error banner. */
export function ghErrorText(e: unknown): string {
  const raw = String((e as Error)?.message ?? e ?? "").trim();
  if (raw === "gh-missing") return "The GitHub CLI (gh) isn't installed.";
  const line = raw.split(/\r?\n/).find((l) => l.trim()) ?? "";
  return line.replace(/^(GraphQL|HTTP \d+):\s*/i, "") || "GitHub request failed.";
}
