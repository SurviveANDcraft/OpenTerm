//! GitHub freshness check: is a session's working directory behind its GitHub
//! remote? Read-only aside from `git fetch`, which only updates
//! remote-tracking refs (`origin/<branch>`) — it never touches the working
//! tree, the index, or local branch refs. No pull/merge/reset ever runs here;
//! that stays a decision the user makes explicitly from the UI.

use serde::Serialize;
use std::path::Path;
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn git_cmd(cwd: &str) -> Command {
    let mut cmd = Command::new("git");
    cmd.current_dir(cwd);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

fn run(cwd: &str, args: &[&str]) -> Result<String, String> {
    let out = git_cmd(cwd).args(args).output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub repo_root: String,
    pub branch: String,
    pub remote_url: String,
    pub ahead: u32,
    pub behind: u32,
    pub dirty: bool,
}

/// Checks whether `cwd` sits inside a GitHub-hosted git repo and, if so,
/// fetches from `origin` and reports how far the local branch has diverged
/// from its upstream. Returns `Ok(None)` when there's no repo, no `origin`
/// remote, the remote isn't GitHub, HEAD is detached, or the fetch itself
/// fails (offline, auth) — all silently skipped rather than surfaced as
/// errors, since this runs on a background timer.
#[tauri::command]
pub async fn check_github_status(cwd: String) -> Result<Option<GitStatus>, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(check_sync(&cwd)))
        .await
        .map_err(|e| e.to_string())?
}

fn check_sync(cwd: &str) -> Option<GitStatus> {
    if !Path::new(cwd).exists() {
        return None;
    }
    let root = run(cwd, &["rev-parse", "--show-toplevel"]).ok()?;
    let remote_url = run(cwd, &["remote", "get-url", "origin"]).ok()?;
    if !remote_url.contains("github.com") {
        return None;
    }
    let branch = run(cwd, &["rev-parse", "--abbrev-ref", "HEAD"]).ok()?;
    if branch.is_empty() || branch == "HEAD" {
        return None; // detached HEAD — nothing sensible to compare
    }
    // The only mutating call: updates `origin/<branch>` in the local ref
    // database. Never touches the working tree or the checked-out branch.
    run(cwd, &["fetch", "--quiet", "origin", &branch]).ok()?;

    let upstream = format!("origin/{branch}");
    let counts = run(
        cwd,
        &["rev-list", "--left-right", "--count", &format!("{branch}...{upstream}")],
    )
    .ok()?;
    let mut parts = counts.split_whitespace();
    let ahead: u32 = parts.next().unwrap_or("0").parse().unwrap_or(0);
    let behind: u32 = parts.next().unwrap_or("0").parse().unwrap_or(0);
    let dirty = !run(cwd, &["status", "--porcelain"]).unwrap_or_default().is_empty();

    Some(GitStatus { repo_root: root, branch, remote_url, ahead, behind, dirty })
}

// ============================= Git Map =============================
// A read-only snapshot of everything locally known about a repo's history and
// refs, laid out for the "Git Map" visual graph in the UI. Never fetches —
// remote-tracking refs (`origin/<branch>`) are only ever as fresh as the last
// background freshness check (see `check_github_status` above), so opening
// the map is instant and offline-safe.

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub sha: String,
    pub is_head: bool,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefInfo {
    pub name: String,
    pub sha: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub sha: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    pub date: String,
    pub subject: String,
    /// Ref decorations git itself attached (`%D`), e.g. `HEAD -> main, origin/main`.
    pub refs: Vec<String>,
    pub files_changed: u32,
    pub insertions: u32,
    pub deletions: u32,
}

/// One entry of `git status --porcelain`: the two-letter status code and the
/// path it applies to (rename arrows collapsed to the destination path).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusFile {
    pub status: String,
    pub path: String,
    pub staged: bool,
    pub untracked: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContributorInfo {
    pub name: String,
    pub count: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashInfo {
    pub name: String,
    pub message: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitMapData {
    pub repo_root: String,
    pub remote_url: Option<String>,
    pub head_branch: String,
    pub dirty: bool,
    pub dirty_count: u32,
    pub branches: Vec<BranchInfo>,
    pub remote_branches: Vec<RefInfo>,
    pub tags: Vec<RefInfo>,
    pub commits: Vec<CommitInfo>,
    pub contributors: Vec<ContributorInfo>,
    pub stashes: Vec<StashInfo>,
    pub status_files: Vec<StatusFile>,
    /// Total commits reachable from any ref — the graph itself is capped.
    pub total_commits: u32,
    /// Commits per week over the last 12 weeks, oldest first.
    pub activity: Vec<u32>,
}

#[tauri::command]
pub async fn git_map(cwd: String) -> Result<Option<GitMapData>, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(map_sync(&cwd)))
        .await
        .map_err(|e| e.to_string())?
}

/// Parses `%(upstream:track)` output, e.g. `"[ahead 2, behind 1]"`, `"[ahead 3]"`,
/// `"[behind 5]"`, `"[gone]"`, or `""` (up to date / no upstream).
fn parse_track(track: &str) -> (u32, u32) {
    let mut ahead = 0u32;
    let mut behind = 0u32;
    for word in ["ahead", "behind"] {
        if let Some(idx) = track.find(word) {
            let rest = &track[idx + word.len()..];
            let digits: String = rest.chars().skip_while(|c| !c.is_ascii_digit()).take_while(|c| c.is_ascii_digit()).collect();
            let n: u32 = digits.parse().unwrap_or(0);
            if word == "ahead" {
                ahead = n;
            } else {
                behind = n;
            }
        }
    }
    (ahead, behind)
}

/// Pulls `(files, insertions, deletions)` out of the trailing `--shortstat`
/// lines of a log record, e.g. ` 3 files changed, 10 insertions(+), 2 deletions(-)`.
/// Merges and empty commits print nothing, which reads back as all zeroes.
fn parse_shortstat<'a>(lines: impl Iterator<Item = &'a str>) -> (u32, u32, u32) {
    let mut out = (0u32, 0u32, 0u32);
    for line in lines {
        if !line.contains("changed") {
            continue;
        }
        for part in line.split(',') {
            let part = part.trim();
            let n: u32 = part
                .split_whitespace()
                .next()
                .and_then(|d| d.parse().ok())
                .unwrap_or(0);
            if part.contains("file") {
                out.0 = n;
            } else if part.contains("insertion") {
                out.1 = n;
            } else if part.contains("deletion") {
                out.2 = n;
            }
        }
    }
    out
}

/// Parses `git status --porcelain` lines into structured entries. Rename lines
/// (`R  old -> new`) collapse to the destination path.
fn parse_status(out: &str) -> Vec<StatusFile> {
    out.lines()
        .filter(|l| l.len() > 3)
        .map(|line| {
            let status = line[..2].to_string();
            let rest = line[3..].trim();
            let path = rest.rsplit(" -> ").next().unwrap_or(rest).trim_matches('"').to_string();
            let untracked = status == "??";
            let staged = !untracked && !status.starts_with(' ');
            StatusFile { status, path, staged, untracked }
        })
        .collect()
}

/// Commit counts bucketed into the last 12 weeks (oldest first) from unix
/// author timestamps.
fn weekly_activity(stamps: &str, now: i64) -> Vec<u32> {
    const WEEKS: usize = 12;
    let week = 7 * 24 * 60 * 60i64;
    let mut buckets = vec![0u32; WEEKS];
    for line in stamps.lines() {
        let Ok(ts) = line.trim().parse::<i64>() else { continue };
        let age = now - ts;
        if age < 0 {
            buckets[WEEKS - 1] += 1;
            continue;
        }
        let idx = (age / week) as usize;
        if idx < WEEKS {
            buckets[WEEKS - 1 - idx] += 1;
        }
    }
    buckets
}

fn map_sync(cwd: &str) -> Option<GitMapData> {
    if !Path::new(cwd).exists() {
        return None;
    }
    let root = run(cwd, &["rev-parse", "--show-toplevel"]).ok()?;
    let remote_url = run(cwd, &["remote", "get-url", "origin"]).ok().filter(|s| !s.is_empty());
    let head_branch = run(cwd, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_default();
    let dirty_lines = run(cwd, &["status", "--porcelain"]).unwrap_or_default();
    let dirty_count = if dirty_lines.is_empty() { 0 } else { dirty_lines.lines().count() as u32 };

    // ---- local branches ----
    let branch_out = run(
        cwd,
        &[
            "for-each-ref",
            "--format=%(refname:short)\t%(objectname)\t%(upstream:short)\t%(upstream:track)",
            "refs/heads",
        ],
    )
    .unwrap_or_default();
    let branches: Vec<BranchInfo> = branch_out
        .lines()
        .filter_map(|line| {
            let mut f = line.splitn(4, '\t');
            let name = f.next()?.to_string();
            let sha = f.next()?.to_string();
            let upstream = f.next().filter(|s| !s.is_empty()).map(|s| s.to_string());
            let (ahead, behind) = parse_track(f.next().unwrap_or(""));
            let is_head = name == head_branch;
            Some(BranchInfo { name, sha, is_head, upstream, ahead, behind })
        })
        .collect();

    // ---- remote-tracking branches ----
    let remote_out = run(
        cwd,
        &["for-each-ref", "--format=%(refname:short)\t%(objectname)", "refs/remotes"],
    )
    .unwrap_or_default();
    let remote_branches: Vec<RefInfo> = remote_out
        .lines()
        .filter_map(|line| {
            let mut f = line.splitn(2, '\t');
            let name = f.next()?.to_string();
            if name.ends_with("/HEAD") {
                return None;
            }
            let sha = f.next()?.to_string();
            Some(RefInfo { name, sha })
        })
        .collect();

    // ---- tags ----
    let tag_out = run(
        cwd,
        &["for-each-ref", "--format=%(refname:short)\t%(*objectname)%(objectname)", "refs/tags"],
    )
    .unwrap_or_default();
    let tags: Vec<RefInfo> = tag_out
        .lines()
        .filter_map(|line| {
            let mut f = line.splitn(2, '\t');
            let name = f.next()?.to_string();
            let sha = f.next()?.to_string();
            Some(RefInfo { name, sha })
        })
        .collect();

    // ---- commit graph: everything reachable from any branch, tag or remote ----
    // Each record is prefixed with \x1e so the trailing `--shortstat` block
    // (which git prints on its own lines, and omits entirely for merges and
    // empty commits) can be attached to the commit it belongs to.
    let log_out = run(
        cwd,
        &[
            "log",
            "--branches",
            "--tags",
            "--remotes",
            "--max-count=200",
            "--date-order",
            "--shortstat",
            "--pretty=format:%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%ad%x1f%D%x1f%s",
            "--date=iso-strict",
        ],
    )
    .unwrap_or_default();
    let commits: Vec<CommitInfo> = log_out
        .split('\u{1e}')
        .filter(|rec| !rec.trim().is_empty())
        .filter_map(|rec| {
            let mut lines = rec.lines();
            let head = lines.next()?;
            let mut f = head.splitn(7, '\u{1f}');
            let sha = f.next()?.to_string();
            let parents = f.next().unwrap_or("").split_whitespace().map(|s| s.to_string()).collect();
            let author_name = f.next().unwrap_or("").to_string();
            let author_email = f.next().unwrap_or("").to_string();
            let date = f.next().unwrap_or("").to_string();
            let refs: Vec<String> = f
                .next()
                .unwrap_or("")
                .split(", ")
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .collect();
            let subject = f.next().unwrap_or("").to_string();
            let (files_changed, insertions, deletions) = parse_shortstat(lines);
            Some(CommitInfo {
                sha,
                parents,
                author_name,
                author_email,
                date,
                subject,
                refs,
                files_changed,
                insertions,
                deletions,
            })
        })
        .collect();

    // ---- contributors ----
    let short_out = run(cwd, &["shortlog", "-sn", "--all", "--no-merges"]).unwrap_or_default();
    let contributors: Vec<ContributorInfo> = short_out
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            let mut parts = trimmed.splitn(2, char::is_whitespace);
            let count: u32 = parts.next()?.trim().parse().ok()?;
            let name = parts.next().unwrap_or("").trim().to_string();
            if name.is_empty() {
                return None;
            }
            Some(ContributorInfo { name, count })
        })
        .collect();

    // ---- stashes ----
    let stash_out = run(cwd, &["stash", "list", "--pretty=format:%gd%x1f%s"]).unwrap_or_default();
    let stashes: Vec<StashInfo> = stash_out
        .lines()
        .filter_map(|line| {
            let mut f = line.splitn(2, '\u{1f}');
            let name = f.next()?.to_string();
            let message = f.next().unwrap_or("").to_string();
            Some(StashInfo { name, message })
        })
        .collect();

    // ---- working tree, totals, recent activity ----
    let status_files = parse_status(&dirty_lines);
    let total_commits: u32 = run(cwd, &["rev-list", "--count", "--all"])
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let stamps = run(cwd, &["log", "--all", "--since=12.weeks", "--pretty=format:%ct"]).unwrap_or_default();
    let activity = weekly_activity(&stamps, now);

    Some(GitMapData {
        repo_root: root,
        remote_url,
        head_branch,
        dirty: dirty_count > 0,
        dirty_count,
        branches,
        remote_branches,
        tags,
        commits,
        contributors,
        stashes,
        status_files,
        total_commits,
        activity,
    })
}
