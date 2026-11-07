//! Universal search (Ctrl+S): the parts that live on disk.
//!
//! - Past agent chats: an in-memory index of the typed prompts and replies in
//!   Claude Code and Codex transcripts. Built on first use, then kept fresh by
//!   reading only the bytes appended since the last look, so a search over
//!   thousands of conversations is a scan of plain strings, not of JSONL.
//! - Files: a gitignore-aware file list per session folder (cached, rebuilt in
//!   the background when stale) ranked by a fuzzy name match, plus a literal
//!   content scan over the same list that gives up when a newer query starts.
//! - Browsers: the ones Windows knows about, so a `site:` result can open in
//!   any of them.
//!
//! Open terminals are searched in the frontend, straight from xterm's buffers.

use memchr::memmem;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, UNIX_EPOCH};

use crate::usage::{claude_user_text, home_dir, parse_iso_ms};

/// Longest stretch of one message kept in the index. Replies longer than this
/// are rare and their tail is mostly code the files search covers anyway.
const MSG_CAP: usize = 12_000;
/// How often the chat index re-stats transcript files at most.
const CHAT_RESCAN: Duration = Duration::from_secs(4);
/// A folder's file list is rebuilt in the background once it is this old.
const FILES_STALE: Duration = Duration::from_secs(20);
/// Files listed per folder at most; a session pointed at a huge tree still
/// answers quickly instead of walking it all.
const FILES_CAP: usize = 60_000;
/// Files larger than this are skipped by the content scan.
const CONTENT_MAX_BYTES: u64 = 1_500_000;

// ===================================================================
//  Shared helpers
// ===================================================================

fn words_of(query: &str) -> Vec<String> {
    query
        .split_whitespace()
        .map(|w| w.to_ascii_lowercase())
        .filter(|w| !w.is_empty())
        .collect()
}

/// Every word occurs in `hay` (already ASCII-lowercased). Returns the byte
/// offset of the first word's first hit, for the snippet.
fn all_words_at(hay: &str, words: &[String]) -> Option<usize> {
    let mut first = None;
    for (i, w) in words.iter().enumerate() {
        let at = memmem::find(hay.as_bytes(), w.as_bytes())?;
        if i == 0 {
            first = Some(at);
        }
    }
    first
}

fn floor_char(s: &str, mut i: usize) -> usize {
    i = i.min(s.len());
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

/// A one-line excerpt around byte `at`, whitespace collapsed, with ellipses
/// where it was cut.
fn snippet(text: &str, at: usize, before: usize, after: usize) -> String {
    let start = floor_char(text, at.saturating_sub(before));
    // Start on a word boundary when one is close, so it doesn't open mid-word.
    let start = if start > 0 {
        text[start..at.max(start)]
            .find(char::is_whitespace)
            .map(|o| start + o + 1)
            .filter(|s| *s <= at)
            .unwrap_or(start)
    } else {
        0
    };
    let end = floor_char(text, at + after);
    let mut out = String::with_capacity(end - start + 8);
    if start > 0 {
        out.push('…');
    }
    let mut last_space = false;
    for ch in text[start..end].chars() {
        if ch.is_whitespace() {
            if !last_space {
                out.push(' ');
            }
            last_space = true;
        } else {
            out.push(ch);
            last_space = false;
        }
    }
    if end < text.len() {
        out.push('…');
    }
    out.trim().to_string()
}

fn truncate(mut s: String, cap: usize) -> String {
    if s.len() > cap {
        let cut = floor_char(&s, cap);
        s.truncate(cut);
    }
    s
}

fn mtime_ms(m: &fs::Metadata) -> i64 {
    m.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Splits `items` across the machine's cores and runs `f` on each slice.
fn par_chunks<T: Sync, R: Send>(items: &[T], f: impl Fn(&[T]) -> R + Sync) -> Vec<R> {
    if items.is_empty() {
        return Vec::new();
    }
    let n = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(1, 12);
    let size = items.len().div_ceil(n).max(1);
    std::thread::scope(|s| {
        let handles: Vec<_> = items.chunks(size).map(|c| s.spawn(|| f(c))).collect();
        handles.into_iter().filter_map(|h| h.join().ok()).collect()
    })
}

// ===================================================================
//  Past agent chats
// ===================================================================

#[derive(Clone, Copy, PartialEq)]
enum Agent {
    Claude,
    Codex,
}

impl Agent {
    fn id(self) -> &'static str {
        match self {
            Agent::Claude => "claude",
            Agent::Codex => "codex",
        }
    }
}

struct Msg {
    at: Option<i64>,
    user: bool,
    text: String,
    lower: String,
}

struct Convo {
    agent: Agent,
    session_id: String,
    cwd: String,
    title: String,
    mtime: i64,
    /// Bytes of the file already parsed (always at a line boundary).
    offset: u64,
    msgs: Vec<Msg>,
}

struct ChatIndex {
    convos: HashMap<PathBuf, Convo>,
    scanned: Option<Instant>,
}

fn chat_index() -> &'static Mutex<ChatIndex> {
    static INDEX: OnceLock<Mutex<ChatIndex>> = OnceLock::new();
    INDEX.get_or_init(|| Mutex::new(ChatIndex { convos: HashMap::new(), scanned: None }))
}

fn transcript_files() -> Vec<(PathBuf, Agent)> {
    let mut out = Vec::new();
    let Some(home) = home_dir() else { return out };
    // Claude Code: ~/.claude/projects/<folder>/<session>.jsonl. Sub-agent
    // transcripts sit one level deeper and are left out on purpose.
    if let Ok(dirs) = fs::read_dir(home.join(".claude").join("projects")) {
        for d in dirs.flatten() {
            let Ok(files) = fs::read_dir(d.path()) else { continue };
            for f in files.flatten() {
                let p = f.path();
                if p.extension().is_some_and(|e| e == "jsonl") {
                    out.push((p, Agent::Claude));
                }
            }
        }
    }
    // Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.
    fn walk(dir: &Path, depth: usize, out: &mut Vec<(PathBuf, Agent)>) {
        let Ok(rd) = fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                if depth < 4 {
                    walk(&p, depth + 1, out);
                }
            } else if p.extension().is_some_and(|e| e == "jsonl") {
                out.push((p, Agent::Codex));
            }
        }
    }
    walk(&home.join(".codex").join("sessions"), 0, &mut out);
    out
}

/// Reads `path` from `offset` up to its last complete line. Returns the new
/// offset and the text read.
fn read_from(path: &Path, offset: u64) -> Option<(u64, String)> {
    let mut f = fs::File::open(path).ok()?;
    f.seek(SeekFrom::Start(offset)).ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    let end = buf.iter().rposition(|b| *b == b'\n').map(|i| i + 1).unwrap_or(0);
    buf.truncate(end);
    Some((offset + end as u64, String::from_utf8_lossy(&buf).into_owned()))
}

fn push_msg(c: &mut Convo, text: String, user: bool, at: Option<i64>) {
    let t = text.trim();
    if t.is_empty() {
        return;
    }
    if user && c.title.is_empty() {
        c.title = snippet(t, 0, 0, 90);
    }
    let text = truncate(t.to_string(), MSG_CAP);
    let mut lower = text.clone();
    lower.make_ascii_lowercase();
    c.msgs.push(Msg { at, user, text, lower });
}

fn parse_claude_line(c: &mut Convo, line: &str) {
    let user = line.contains("\"type\":\"user\"");
    if !user && !line.contains("\"type\":\"assistant\"") {
        return;
    }
    // Tool results are user records too; they're tool output, not chat.
    if user && line.contains("\"tool_use_id\"") {
        return;
    }
    let Ok(v) = serde_json::from_str::<Value>(line) else { return };
    if c.cwd.is_empty() {
        if let Some(cwd) = v.get("cwd").and_then(Value::as_str) {
            c.cwd = cwd.to_string();
        }
    }
    if let Some(id) = v.get("sessionId").and_then(Value::as_str) {
        if c.session_id != id {
            c.session_id = id.to_string();
        }
    }
    let at = v.get("timestamp").and_then(Value::as_str).and_then(parse_iso_ms);
    match v.get("type").and_then(Value::as_str) {
        Some("user") => {
            if let Some(t) = claude_user_text(&v) {
                push_msg(c, t, true, at);
            }
        }
        Some("assistant") => {
            if v.get("isSidechain").and_then(Value::as_bool) == Some(true) {
                return;
            }
            let Some(parts) = v.pointer("/message/content").and_then(Value::as_array) else { return };
            let text: Vec<&str> = parts
                .iter()
                .filter(|p| p.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|p| p.get("text").and_then(Value::as_str))
                .collect();
            if !text.is_empty() {
                push_msg(c, text.join("\n"), false, at);
            }
        }
        _ => {}
    }
}

fn parse_codex_line(c: &mut Convo, line: &str) {
    let meta = line.contains("\"session_meta\"");
    if !meta && !line.contains("\"user_message\"") && !line.contains("\"agent_message\"") {
        return;
    }
    let Ok(v) = serde_json::from_str::<Value>(line) else { return };
    let p = &v["payload"];
    match v.get("type").and_then(Value::as_str) {
        Some("session_meta") => {
            if let Some(id) = p.get("id").and_then(Value::as_str) {
                c.session_id = id.to_string();
            }
            if let Some(cwd) = p.get("cwd").and_then(Value::as_str) {
                c.cwd = cwd.to_string();
            }
        }
        Some("event_msg") => {
            let user = match p.get("type").and_then(Value::as_str) {
                Some("user_message") => true,
                Some("agent_message") => false,
                _ => return,
            };
            let Some(t) = p.get("message").and_then(Value::as_str) else { return };
            let at = v.get("timestamp").and_then(Value::as_str).and_then(parse_iso_ms);
            push_msg(c, t.to_string(), user, at);
        }
        _ => {}
    }
}

/// Parses whatever was appended to `path` since `c.offset`.
fn update_convo(path: &Path, c: &mut Convo) {
    let Some((offset, text)) = read_from(path, c.offset) else { return };
    c.offset = offset;
    for line in text.lines() {
        match c.agent {
            Agent::Claude => parse_claude_line(c, line),
            Agent::Codex => parse_codex_line(c, line),
        }
    }
}

fn new_convo(path: &Path, agent: Agent) -> Convo {
    Convo {
        agent,
        // Claude names the file after the session; Codex's comes from its meta line.
        session_id: path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
        cwd: String::new(),
        title: String::new(),
        mtime: 0,
        offset: 0,
        msgs: Vec::new(),
    }
}

/// Brings the index up to date with the transcript folders. Cheap when
/// nothing changed: one stat per file, at most every few seconds.
fn refresh_chats(idx: &mut ChatIndex) {
    if idx.scanned.is_some_and(|t| t.elapsed() < CHAT_RESCAN) {
        return;
    }
    let files = transcript_files();
    let mut todo: Vec<(PathBuf, Agent, u64, i64)> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (path, agent) in files {
        let Ok(m) = fs::metadata(&path) else { continue };
        let len = m.len();
        seen.insert(path.clone());
        match idx.convos.get(&path) {
            Some(c) if c.offset == len => {}
            _ => todo.push((path, agent, len, mtime_ms(&m))),
        }
    }
    idx.convos.retain(|p, _| seen.contains(p));

    // Take the convos that need work out of the map so threads can own them.
    let mut work: Vec<(PathBuf, Convo, i64)> = todo
        .into_iter()
        .map(|(path, agent, len, mtime)| {
            let c = match idx.convos.remove(&path) {
                // Shrunk means rewritten: start over.
                Some(c) if c.offset <= len => c,
                _ => new_convo(&path, agent),
            };
            (path, c, mtime)
        })
        .collect();
    let n = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(1, 12);
    let size = work.len().div_ceil(n).max(1);
    std::thread::scope(|s| {
        for chunk in work.chunks_mut(size) {
            s.spawn(move || {
                for (path, c, mtime) in chunk.iter_mut() {
                    update_convo(path, c);
                    c.mtime = *mtime;
                }
            });
        }
    });
    for (path, c, _) in work {
        idx.convos.insert(path, c);
    }
    idx.scanned = Some(Instant::now());
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHit {
    agent: &'static str,
    session_id: String,
    cwd: String,
    title: String,
    at: Option<i64>,
    from_user: bool,
    snippet: String,
    /// Matching messages in this conversation (only the best is returned).
    hits: usize,
}

fn search_chats_sync(query: &str, limit: usize) -> Vec<ChatHit> {
    let words = words_of(query);
    let mut idx = chat_index().lock().unwrap_or_else(|e| e.into_inner());
    refresh_chats(&mut idx);
    if words.is_empty() {
        return Vec::new();
    }
    let phrase = words.join(" ");
    let convos: Vec<&Convo> = idx.convos.values().filter(|c| !c.msgs.is_empty()).collect();
    let per: Vec<Vec<(i64, ChatHit)>> = par_chunks(&convos, |chunk| {
        let mut out = Vec::new();
        for c in chunk {
            // Best message per conversation: a whole-phrase hit beats scattered
            // words, your own prompt beats the agent's reply, newer beats older.
            let mut best: Option<(i64, &Msg, usize)> = None;
            let mut hits = 0;
            for m in &c.msgs {
                let Some(at) = all_words_at(&m.lower, &words) else { continue };
                hits += 1;
                let exact = words.len() > 1 && memmem::find(m.lower.as_bytes(), phrase.as_bytes()).is_some();
                let score = (exact as i64) * 4 + (m.user as i64) * 2;
                if best.as_ref().is_none_or(|(s, bm, _)| {
                    score > *s || (score == *s && m.at.unwrap_or(0) >= bm.at.unwrap_or(0))
                }) {
                    best = Some((score, m, at));
                }
            }
            let Some((score, m, at)) = best else { continue };
            let when = m.at.unwrap_or(c.mtime);
            // Recency dominates; a phrase or prompt hit is worth about a week.
            let rank = when + score * 2 * 86_400_000 + (hits.min(20) as i64) * 3_600_000;
            out.push((
                rank,
                ChatHit {
                    agent: c.agent.id(),
                    session_id: c.session_id.clone(),
                    cwd: c.cwd.clone(),
                    title: c.title.clone(),
                    at: Some(when),
                    from_user: m.user,
                    snippet: snippet(&m.text, at, 70, 170),
                    hits,
                },
            ));
        }
        out
    });
    let mut all: Vec<(i64, ChatHit)> = per.into_iter().flatten().collect();
    all.sort_by(|a, b| b.0.cmp(&a.0));
    all.into_iter().take(limit).map(|(_, h)| h).collect()
}

#[tauri::command]
pub async fn search_chats(query: String, limit: Option<usize>) -> Result<Vec<ChatHit>, String> {
    let limit = limit.unwrap_or(30).min(200);
    tauri::async_runtime::spawn_blocking(move || search_chats_sync(&query, limit))
        .await
        .map_err(|e| e.to_string())
}

// ===================================================================
//  Files
// ===================================================================

struct FileList {
    /// Paths relative to the root, forward slashes.
    rel: Arc<Vec<String>>,
    lower: Arc<Vec<String>>,
    built: Instant,
}

struct FileIndex {
    roots: HashMap<String, FileList>,
    building: std::collections::HashSet<String>,
}

fn file_index() -> &'static Mutex<FileIndex> {
    static INDEX: OnceLock<Mutex<FileIndex>> = OnceLock::new();
    INDEX.get_or_init(|| {
        Mutex::new(FileIndex { roots: HashMap::new(), building: Default::default() })
    })
}

fn same_path(a: &Path, b: &Path) -> bool {
    let n = |p: &Path| p.to_string_lossy().trim_end_matches(['\\', '/']).to_ascii_lowercase();
    n(a) == n(b)
}

fn walk_root(root: &str) -> FileList {
    let mut rel = Vec::new();
    let base = Path::new(root);
    // A drive root is too broad to list at all; a session rooted at the home
    // folder gets its top few levels, minus the app-data and cloud-sync bulk.
    let home = home_dir().is_some_and(|h| same_path(&h, base));
    if base.is_dir() && base.parent().is_some() {
        let walker = ignore::WalkBuilder::new(base)
            .hidden(false)
            .git_global(false)
            .require_git(false)
            .max_depth(Some(if home { 3 } else { 14 }))
            .filter_entry(move |e| {
                let n = e.file_name().to_string_lossy();
                if n == ".git" || n == "node_modules" || n == "target" || n == ".next" {
                    return false;
                }
                !(home && e.depth() == 1 && (n == "AppData" || n.starts_with('.') || n.starts_with("OneDrive")))
            })
            .build();
        for e in walker.flatten() {
            if !e.file_type().is_some_and(|t| t.is_file()) {
                continue;
            }
            if let Ok(r) = e.path().strip_prefix(base) {
                rel.push(r.to_string_lossy().replace('\\', "/"));
                if rel.len() >= FILES_CAP {
                    break;
                }
            }
        }
    }
    rel.sort_unstable();
    let lower = rel.iter().map(|s| s.to_ascii_lowercase()).collect();
    FileList { rel: Arc::new(rel), lower: Arc::new(lower), built: Instant::now() }
}

/// The current file list for `root`. Builds it on first use; afterwards a
/// stale list is served while a fresh one is built in the background.
fn files_for(root: &str) -> (Arc<Vec<String>>, Arc<Vec<String>>) {
    {
        let mut idx = file_index().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(l) = idx.roots.get(root) {
            let out = (l.rel.clone(), l.lower.clone());
            if l.built.elapsed() > FILES_STALE && idx.building.insert(root.to_string()) {
                let r = root.to_string();
                std::thread::spawn(move || {
                    let list = walk_root(&r);
                    let mut idx = file_index().lock().unwrap_or_else(|e| e.into_inner());
                    idx.building.remove(&r);
                    idx.roots.insert(r, list);
                });
            }
            return out;
        }
    }
    let list = walk_root(root);
    let out = (list.rel.clone(), list.lower.clone());
    file_index().lock().unwrap_or_else(|e| e.into_inner()).roots.insert(root.to_string(), list);
    out
}

fn is_sep(b: u8) -> bool {
    matches!(b, b'/' | b'_' | b'-' | b'.' | b' ')
}

/// Fuzzy score of one query word against a lowercased relative path, with the
/// byte positions it matched. Substring hits in the file name rank highest,
/// then substring hits anywhere, then in-order letters that favor word starts.
fn score_word(path: &[u8], name_start: usize, w: &[u8], pos: &mut Vec<usize>) -> Option<i64> {
    let name = &path[name_start..];
    if let Some(i) = memmem::find(name, w) {
        let at = name_start + i;
        pos.extend(at..at + w.len());
        let mut s = 120 + w.len() as i64 * 4;
        if i == 0 {
            s += 60;
        }
        if name.len() == w.len() || name.get(w.len()) == Some(&b'.') && i == 0 {
            s += 120; // the whole file name (with or without extension)
        }
        return Some(s);
    }
    if let Some(i) = memmem::find(path, w) {
        pos.extend(i..i + w.len());
        let boundary = i == 0 || is_sep(path[i - 1]);
        return Some(50 + w.len() as i64 * 3 + if boundary { 25 } else { 0 });
    }
    // In-order letters. Greedy from the right end of the path would favor the
    // file name; from the left is simpler and good enough with the bonuses.
    let mut s = 0i64;
    let mut pi = 0usize;
    let mut prev: Option<usize> = None;
    let start = pos.len();
    for &c in w {
        let mut found = None;
        while pi < path.len() {
            if path[pi] == c {
                found = Some(pi);
                pi += 1;
                break;
            }
            pi += 1;
        }
        let i = found?;
        let mut b = 1;
        if i == 0 || is_sep(path[i - 1]) {
            b += 6;
        }
        if prev.is_some_and(|p| p + 1 == i) {
            b += 4;
        }
        if i >= name_start {
            b += 2;
        }
        s += b;
        prev = Some(i);
        pos.push(i);
    }
    // Letters strewn across the whole path are noise, not a match.
    let span = pos[pos.len() - 1] - pos[start] + 1;
    if span > w.len() * 6 + 8 {
        pos.truncate(start);
        return None;
    }
    Some(s)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHit {
    root: String,
    rel: String,
    /// Character indices into `rel` that matched, for highlighting.
    positions: Vec<usize>,
}

fn search_file_names_sync(query: &str, roots: &[String], limit: usize) -> Vec<FileHit> {
    let words = words_of(query);
    if words.is_empty() {
        return Vec::new();
    }
    let mut all: Vec<(i64, FileHit)> = Vec::new();
    for (ri, root) in roots.iter().enumerate() {
        let (rel, lower) = files_for(root);
        // The current session's folder comes first and gets a head start.
        let root_bonus = if ri == 0 { 40 } else { 0 };
        let idx: Vec<usize> = (0..lower.len()).collect();
        let per = par_chunks(&idx, |chunk| {
            let mut out: Vec<(i64, usize, Vec<usize>)> = Vec::new();
            let mut pos = Vec::new();
            'files: for &i in chunk {
                let p = lower[i].as_bytes();
                let name_start = p.iter().rposition(|b| *b == b'/').map(|i| i + 1).unwrap_or(0);
                pos.clear();
                let mut s = 0;
                for w in &words {
                    match score_word(p, name_start, w.as_bytes(), &mut pos) {
                        Some(ws) => s += ws,
                        None => continue 'files,
                    }
                }
                // Shallow, short paths win ties.
                let depth = p.iter().filter(|b| **b == b'/').count() as i64;
                s -= depth * 3 + (p.len() as i64) / 12;
                out.push((s + root_bonus, i, pos.clone()));
            }
            out
        });
        let mut hits: Vec<(i64, usize, Vec<usize>)> = per.into_iter().flatten().collect();
        hits.sort_by(|a, b| b.0.cmp(&a.0));
        for (s, i, mut pos) in hits.into_iter().take(limit) {
            pos.sort_unstable();
            pos.dedup();
            let r = &rel[i];
            // Byte offsets → char indices (paths are mostly ASCII; this keeps
            // the highlight right when they aren't).
            let positions = if r.is_ascii() {
                pos
            } else {
                pos.into_iter().map(|b| r[..floor_char(r, b)].chars().count()).collect()
            };
            all.push((s, FileHit { root: root.clone(), rel: r.clone(), positions }));
        }
    }
    all.sort_by(|a, b| b.0.cmp(&a.0));
    all.into_iter().take(limit).map(|(_, h)| h).collect()
}

#[tauri::command]
pub async fn search_file_names(
    query: String,
    roots: Vec<String>,
    limit: Option<usize>,
) -> Result<Vec<FileHit>, String> {
    let limit = limit.unwrap_or(30).min(300);
    tauri::async_runtime::spawn_blocking(move || search_file_names_sync(&query, &roots, limit))
        .await
        .map_err(|e| e.to_string())
}

/// Bumped by every content search; a running scan stops when it's no longer
/// the newest, so fast typing never queues up full scans.
static CONTENT_GEN: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentLine {
    line: usize,
    text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentHit {
    root: String,
    rel: String,
    lines: Vec<ContentLine>,
    /// Matching lines in the file (only the first few are returned).
    total: usize,
}

fn scan_file(path: &Path, words: &[String]) -> Option<(Vec<ContentLine>, usize)> {
    let m = fs::metadata(path).ok()?;
    if m.len() == 0 || m.len() > CONTENT_MAX_BYTES {
        return None;
    }
    let mut bytes = fs::read(path).ok()?;
    if memchr::memchr(0, &bytes[..bytes.len().min(8000)]).is_some() {
        return None; // binary
    }
    let orig = bytes.clone();
    bytes.make_ascii_lowercase();
    // Cheap reject before walking lines: every word somewhere in the file.
    for w in words {
        memmem::find(&bytes, w.as_bytes())?;
    }
    let first = memmem::Finder::new(words[0].as_bytes());
    let mut lines = Vec::new();
    let mut total = 0;
    let mut line_no = 1usize;
    let mut line_start = 0usize;
    let mut scanned = 0usize; // bytes counted for line numbers so far
    for hit in first.find_iter(&bytes) {
        if hit < line_start {
            continue; // same line as a previous hit
        }
        line_no += memchr::memchr_iter(b'\n', &bytes[scanned..hit]).count();
        scanned = hit;
        let ls = memchr::memrchr(b'\n', &bytes[..hit]).map(|i| i + 1).unwrap_or(0);
        let le = memchr::memchr(b'\n', &bytes[hit..]).map(|i| hit + i).unwrap_or(bytes.len());
        line_start = le + 1;
        let lower_line = &bytes[ls..le];
        if words[1..].iter().all(|w| memmem::find(lower_line, w.as_bytes()).is_some()) {
            total += 1;
            if lines.len() < 4 {
                let text = String::from_utf8_lossy(&orig[ls..le]);
                let text = text.trim_end_matches('\r');
                let s = snippet(text, hit - ls, 50, 150);
                lines.push(ContentLine { line: line_no, text: s });
            }
        }
    }
    (total > 0).then_some((lines, total))
}

fn search_file_contents_sync(query: &str, roots: &[String], limit: usize, gen: u64) -> Vec<ContentHit> {
    let words = words_of(query);
    // Two-letter needles match half of every file; not worth scanning for.
    if words.is_empty() || words.iter().map(String::len).max().unwrap_or(0) < 3 {
        return Vec::new();
    }
    let started = Instant::now();
    let stop = AtomicBool::new(false);
    let mut out = Vec::new();
    for root in roots {
        if CONTENT_GEN.load(Ordering::Relaxed) != gen || out.len() >= limit {
            break;
        }
        let (rel, _) = files_for(root);
        let base = PathBuf::from(root);
        let per = par_chunks(&rel, |chunk| {
            let mut found = Vec::new();
            for r in chunk {
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                if CONTENT_GEN.load(Ordering::Relaxed) != gen || started.elapsed() > Duration::from_secs(4) {
                    stop.store(true, Ordering::Relaxed);
                    break;
                }
                if let Some((lines, total)) = scan_file(&base.join(r), &words) {
                    found.push(ContentHit { root: root.clone(), rel: r.clone(), lines, total });
                }
            }
            found
        });
        let mut hits: Vec<ContentHit> = per.into_iter().flatten().collect();
        // Shallow files first, then the ones with the most hits.
        hits.sort_by(|a, b| {
            let da = a.rel.matches('/').count();
            let db = b.rel.matches('/').count();
            da.cmp(&db).then(b.total.cmp(&a.total)).then(a.rel.cmp(&b.rel))
        });
        out.extend(hits);
    }
    out.truncate(limit);
    out
}

#[tauri::command]
pub async fn search_file_contents(
    query: String,
    roots: Vec<String>,
    limit: Option<usize>,
) -> Result<Vec<ContentHit>, String> {
    let gen = CONTENT_GEN.fetch_add(1, Ordering::Relaxed) + 1;
    let limit = limit.unwrap_or(40).min(300);
    tauri::async_runtime::spawn_blocking(move || search_file_contents_sync(&query, &roots, limit, gen))
        .await
        .map_err(|e| e.to_string())
}

/// Starts building the chat index and the file lists for `roots` in the
/// background, so the first keystroke after opening search has them ready.
#[tauri::command]
pub fn search_warm(roots: Vec<String>) {
    std::thread::spawn(move || {
        for r in &roots {
            let _ = files_for(r);
        }
        let mut idx = chat_index().lock().unwrap_or_else(|e| e.into_inner());
        refresh_chats(&mut idx);
    });
}

// ===================================================================
//  Browsers
// ===================================================================

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Browser {
    id: String,
    name: String,
    #[serde(skip)]
    exe: String,
}

/// Browsers registered with Windows under `Clients\StartMenuInternet`, for the
/// machine and the current user.
fn installed_browsers() -> Vec<Browser> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;
    let mut out: Vec<Browser> = Vec::new();
    let places = [
        (HKEY_CURRENT_USER, r"SOFTWARE\Clients\StartMenuInternet"),
        (HKEY_LOCAL_MACHINE, r"SOFTWARE\Clients\StartMenuInternet"),
        (HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Clients\StartMenuInternet"),
    ];
    for (hive, path) in places {
        let Ok(key) = RegKey::predef(hive).open_subkey(path) else { continue };
        for id in key.enum_keys().flatten() {
            let Ok(k) = key.open_subkey(&id) else { continue };
            let name: String = k.get_value("").unwrap_or_else(|_| id.clone());
            let Ok(cmd) = k.open_subkey(r"shell\open\command") else { continue };
            let Ok(cmd): Result<String, _> = cmd.get_value("") else { continue };
            let cmd = cmd.trim();
            let exe = if let Some(rest) = cmd.strip_prefix('"') {
                rest.split('"').next().unwrap_or("").to_string()
            } else {
                let lower = cmd.to_ascii_lowercase();
                match lower.find(".exe") {
                    Some(i) => cmd[..i + 4].to_string(),
                    None => cmd.to_string(),
                }
            };
            if exe.is_empty() || !Path::new(&exe).is_file() {
                continue;
            }
            let key = exe.to_ascii_lowercase();
            if out.iter().any(|b| b.exe.to_ascii_lowercase() == key) {
                continue;
            }
            out.push(Browser { id: id.clone(), name, exe });
        }
    }
    out.sort_by(|a, b| a.name.to_ascii_lowercase().cmp(&b.name.to_ascii_lowercase()));
    out
}

#[tauri::command]
pub async fn list_browsers() -> Result<Vec<Browser>, String> {
    tauri::async_runtime::spawn_blocking(installed_browsers)
        .await
        .map_err(|e| e.to_string())
}

/// Opens `url` in one of the registered browsers. Only http(s) links, and only
/// a browser Windows lists, so this can't be used to launch anything else.
#[tauri::command]
pub fn open_url_with(browser_id: String, url: String) -> Result<(), String> {
    let lower = url.trim().to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://")) {
        return Err(format!("not a web link: {url}"));
    }
    let b = installed_browsers()
        .into_iter()
        .find(|b| b.id == browser_id)
        .ok_or_else(|| "That browser isn't installed anymore.".to_string())?;
    std::process::Command::new(&b.exe)
        .arg(url.trim())
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_name_beats_scattered_letters() {
        let mut pos = Vec::new();
        let p = b"src/searchmodal.ts";
        let a = score_word(p, 4, b"search", &mut pos).unwrap();
        pos.clear();
        let b = score_word(b"src/secrets/handler.rs", 12, b"search", &mut pos);
        assert!(b.is_none() || a > b.unwrap());
    }

    #[test]
    fn snippet_collapses_whitespace() {
        let s = snippet("hello\n\n   world   foo", 0, 10, 40);
        assert_eq!(s, "hello world foo");
    }

    #[test]
    fn all_words_required() {
        let w = words_of("Foo bar");
        assert!(all_words_at("xx foo yy bar", &w).is_some());
        assert!(all_words_at("xx foo yy", &w).is_none());
    }
}

#[cfg(test)]
mod bench {
    use super::*;

    /// `cargo test bench_real -- --ignored --nocapture`: timings on this machine's data.
    #[test]
    #[ignore]
    fn bench_real() {
        let t = Instant::now();
        let hits = search_chats_sync("search", 10);
        let n = chat_index().lock().unwrap().convos.len();
        println!("chats cold: {:?}, {} convos, {} hits", t.elapsed(), n, hits.len());
        let t = Instant::now();
        let hits = search_chats_sync("usage limit", 10);
        println!("chats warm: {:?}, {} hits; top: {:?}", t.elapsed(), hits.len(), hits.first().map(|h| &h.snippet));
        let root = std::env::current_dir().unwrap().parent().unwrap().to_string_lossy().to_string();
        let roots = vec![root];
        let t = Instant::now();
        let f = search_file_names_sync("srchmod", &roots, 5);
        println!("names cold: {:?} {:?}", t.elapsed(), f.iter().map(|h| &h.rel).collect::<Vec<_>>());
        let t = Instant::now();
        let f = search_file_names_sync("main", &roots, 5);
        println!("names warm: {:?} {:?}", t.elapsed(), f.iter().map(|h| &h.rel).collect::<Vec<_>>());
        let t = Instant::now();
        let c = search_file_contents_sync("previewSearch", &roots, 20, CONTENT_GEN.load(Ordering::Relaxed));
        println!("contents: {:?} {:?}", t.elapsed(), c.iter().map(|h| (&h.rel, h.total, h.lines.first().map(|l| l.line))).collect::<Vec<_>>());
    }
}
