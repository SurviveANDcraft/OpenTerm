/** GitHub freshness checks: is a session's working directory behind its GitHub
 *  remote? Runs `git fetch` (updates remote-tracking refs only — never the
 *  working tree) via the Rust side, then reports ahead/behind counts. Nothing
 *  here ever pulls, merges, or resets; that's left entirely to the user,
 *  guided by the AI review prompt built below. */

import { invoke } from "@tauri-apps/api/core";

export interface GitStatusResult {
  repoRoot: string;
  branch: string;
  remoteUrl: string;
  ahead: number;
  behind: number;
  dirty: boolean;
}

/** Returns `null` when `cwd` isn't inside a GitHub-hosted repo (no repo, no
 *  `origin` remote, remote isn't GitHub, detached HEAD) or the fetch failed
 *  (offline, auth) — all treated the same: nothing to report this round. */
export async function checkGithubStatus(cwd: string): Promise<GitStatusResult | null> {
  try {
    return await invoke<GitStatusResult | null>("check_github_status", { cwd });
  } catch {
    return null;
  }
}

/** Prompt handed to the agent CLI when the user asks to "Review with AI" from
 *  an out-of-date-with-GitHub inbox item. Gives the agent the facts already
 *  gathered (so it doesn't need to re-run `git fetch` itself) and is explicit,
 *  repeatedly, that it must not run any commands — git or otherwise — without
 *  the user first approving them in this same conversation. */
export function buildGithubReviewPrompt(status: GitStatusResult): string {
  const lines: string[] = [];
  lines.push(
    `# GitHub sync check`,
    `This repository is behind its GitHub remote. Here is what was already found (no need to re-fetch):`,
    ``,
    `- Repo: ${status.repoRoot}`,
    `- Remote: ${status.remoteUrl}`,
    `- Branch: ${status.branch}`,
    `- Commits behind origin/${status.branch}: ${status.behind}`,
    `- Commits ahead of origin/${status.branch}: ${status.ahead}`,
    `- Uncommitted local changes: ${status.dirty ? "yes" : "no"}`,
    ``,
    `Please do the following:`,
    `1. Look at what's new on the remote (e.g. \`git log HEAD..origin/${status.branch}\`, \`git diff HEAD..origin/${status.branch}\` — read-only commands only) and summarize in plain language what changed upstream and whether it looks likely to conflict with any local work.`,
    `2. Explain the situation to me clearly: how far behind we are, what the incoming commits look like, and whether my ${status.dirty ? "uncommitted local changes" : "working tree"} could be affected.`,
    `3. Recommend a course of action (e.g. plain \`git pull\`, fetch + rebase, stash first, etc.) and explain the tradeoffs briefly.`,
    `4. Ask me explicitly which action I'd like to take.`,
    ``,
    `IMPORTANT: Do not run \`git pull\`, \`git merge\`, \`git rebase\`, \`git reset\`, \`git stash\`, or any other command that changes files, the index, or history — or any command at all beyond read-only inspection — until I have explicitly told you to and which one to run. Investigate and explain first; act only after I approve a specific action.`
  );
  return lines.join("\n");
}

// ============================= Git Map =============================

export interface GitBranchInfo {
  name: string;
  sha: string;
  isHead: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
}

export interface GitRefInfo {
  name: string;
  sha: string;
}

export interface GitCommitInfo {
  sha: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  date: string;
  subject: string;
  /** Ref decorations git attached to this commit, e.g. `HEAD -> main`. */
  refs: string[];
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export interface GitStatusFile {
  status: string;
  path: string;
  staged: boolean;
  untracked: boolean;
}

export interface GitContributorInfo {
  name: string;
  count: number;
}

export interface GitStashInfo {
  name: string;
  message: string;
}

export interface GitMapData {
  repoRoot: string;
  remoteUrl: string | null;
  headBranch: string;
  dirty: boolean;
  dirtyCount: number;
  branches: GitBranchInfo[];
  remoteBranches: GitRefInfo[];
  tags: GitRefInfo[];
  commits: GitCommitInfo[];
  contributors: GitContributorInfo[];
  stashes: GitStashInfo[];
  statusFiles: GitStatusFile[];
  /** Total commits reachable from any ref; `commits` itself is capped. */
  totalCommits: number;
  /** Commits per week over the last 12 weeks, oldest first. */
  activity: number[];
}

/** Read-only snapshot of a repo's refs and history for the Git Map view.
 *  Never fetches — remote-tracking refs are only as fresh as the last
 *  background {@link checkGithubStatus} run, so this is instant and offline-safe.
 *  Returns `null` when `cwd` isn't inside a git repo. */
export async function fetchGitMap(cwd: string): Promise<GitMapData | null> {
  try {
    return await invoke<GitMapData | null>("git_map", { cwd });
  } catch {
    return null;
  }
}
