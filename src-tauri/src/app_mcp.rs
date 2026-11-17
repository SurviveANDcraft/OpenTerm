//! The local MCP server agents call OpenTerm's own tools through (tasks,
//! sessions, timers, panels, a safe subset of settings, terminals). Threads
//! pass it to Claude Code with `--mcp-config`.
//!
//! Streamable HTTP (MCP 2025-06-18) in its simplest legal form: every POST to
//! `/mcp` carries one JSON-RPC message and gets one `application/json` answer;
//! there is no server-initiated stream, so GET is 405. It binds 127.0.0.1 on a
//! random port, every request needs the random bearer token, and Host/Origin
//! must be loopback (DNS-rebinding guard). Tool calls are handed to a
//! `ToolHandler`; in the app that is the webview, which runs them through the
//! same tool code as the Agents assistant (see `WebviewTools` below).

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;

/// The server name Claude sees; its tools become `mcp__openterm__<tool>`.
pub const SERVER_NAME: &str = "openterm";
const PROTOCOLS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_HEADER: usize = 16 * 1024;
const MAX_BODY: usize = 1024 * 1024;

pub struct ToolOutcome {
    pub text: String,
    pub is_error: bool,
}

pub type ToolFuture = Pin<Box<dyn Future<Output = ToolOutcome> + Send>>;

/// Lists and runs the tools the server exposes.
pub trait ToolHandler: Send + Sync + 'static {
    /// MCP tool descriptors: `{name, description, inputSchema}`.
    fn tools(&self) -> Vec<Value>;
    /// `caller` is the `X-OpenTerm-Thread` header: which thread is asking.
    fn call(&self, name: String, arguments: Value, caller: Option<String>) -> ToolFuture;
}

/// A running server. Dropping it stops it.
pub struct McpServer {
    port: u16,
    token: String,
    shutdown: Option<oneshot::Sender<()>>,
}

impl McpServer {
    pub async fn start(handler: Arc<dyn ToolHandler>) -> std::io::Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let port = listener.local_addr()?.port();
        let token = random_token()?;
        let (tx, mut rx) = oneshot::channel::<()>();
        let auth = Arc::new(Gate { port, token: token.clone() });
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut rx => break,
                    accepted = listener.accept() => {
                        let Ok((stream, peer)) = accepted else { continue };
                        if !peer.ip().is_loopback() { continue; }
                        tauri::async_runtime::spawn(serve(stream, auth.clone(), handler.clone()));
                    }
                }
            }
        });
        Ok(Self { port, token, shutdown: Some(tx) })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}/mcp", self.port())
    }

    /// The `--mcp-config` document for Claude Code.
    pub fn claude_config(&self) -> Value {
        json!({ "mcpServers": { SERVER_NAME: {
            "type": "http",
            "url": self.url(),
            "headers": { "Authorization": format!("Bearer {}", self.token) },
        }}})
    }

    pub fn stop(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
    }
}

impl Drop for McpServer {
    fn drop(&mut self) {
        self.stop();
    }
}

fn random_token() -> std::io::Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|e| std::io::Error::other(e.to_string()))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

struct Gate {
    port: u16,
    token: String,
}

impl Gate {
    fn loopback_host(&self, host: &str) -> bool {
        [format!("127.0.0.1:{}", self.port), format!("localhost:{}", self.port)].iter().any(|h| h.eq_ignore_ascii_case(host))
    }

    fn token_ok(&self, header: Option<&str>) -> bool {
        let Some(given) = header.and_then(|h| h.strip_prefix("Bearer ")) else { return false };
        let (a, b) = (given.as_bytes(), self.token.as_bytes());
        a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
    }
}

struct Request {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

async fn read_request(stream: &mut TcpStream) -> Option<Request> {
    let mut buf = Vec::with_capacity(4096);
    let head_end = loop {
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i;
        }
        if buf.len() > MAX_HEADER {
            return None;
        }
        let mut chunk = [0u8; 4096];
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
    };
    let head = std::str::from_utf8(&buf[..head_end]).ok()?;
    let mut lines = head.split("\r\n");
    let mut first = lines.next()?.split(' ');
    let (method, path) = (first.next()?.to_string(), first.next()?.to_string());
    let headers: Vec<(String, String)> = lines
        .filter_map(|l| l.split_once(':').map(|(k, v)| (k.trim().to_string(), v.trim().to_string())))
        .collect();
    let len = headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, v)| v.parse::<usize>().ok())
        .unwrap_or(0);
    if len > MAX_BODY {
        return None;
    }
    let mut body = buf[head_end + 4..].to_vec();
    while body.len() < len {
        let mut chunk = vec![0u8; (len - body.len()).min(64 * 1024)];
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    body.truncate(len);
    Some(Request { method, path, headers, body })
}

async fn respond(stream: &mut TcpStream, status: &str, extra: &[(&str, &str)], body: &str) {
    let mut out = format!("HTTP/1.1 {status}\r\nconnection: close\r\ncache-control: no-store\r\ncontent-length: {}\r\n", body.len());
    if !body.is_empty() {
        out.push_str("content-type: application/json\r\n");
    }
    for (k, v) in extra {
        out.push_str(&format!("{k}: {v}\r\n"));
    }
    out.push_str("\r\n");
    out.push_str(body);
    let _ = stream.write_all(out.as_bytes()).await;
    let _ = stream.shutdown().await;
}

async fn serve(mut stream: TcpStream, gate: Arc<Gate>, handler: Arc<dyn ToolHandler>) {
    // A client that never finishes its request doesn't hold a task forever.
    let Ok(Some(req)) = tokio::time::timeout(std::time::Duration::from_secs(30), read_request(&mut stream)).await else {
        return respond(&mut stream, "400 Bad Request", &[], "").await;
    };
    if !req.header("host").is_some_and(|h| gate.loopback_host(h)) {
        return respond(&mut stream, "403 Forbidden", &[], "").await;
    }
    if let Some(origin) = req.header("origin") {
        // Exactly a loopback origin (any port): a prefix match would also
        // let `http://127.0.0.1.evil.example` through.
        let o = origin.to_ascii_lowercase();
        let loopback = ["http://127.0.0.1", "http://localhost"].iter().any(|base| {
            o.strip_prefix(base).is_some_and(|rest| rest.is_empty() || rest.strip_prefix(':').is_some_and(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())))
        });
        if !loopback {
            return respond(&mut stream, "403 Forbidden", &[], "").await;
        }
    }
    if !gate.token_ok(req.header("authorization")) {
        return respond(&mut stream, "401 Unauthorized", &[("www-authenticate", "Bearer")], r#"{"error":"unauthorized"}"#).await;
    }
    if req.path.split('?').next() != Some("/mcp") {
        return respond(&mut stream, "404 Not Found", &[], "").await;
    }
    if req.method != "POST" {
        return respond(&mut stream, "405 Method Not Allowed", &[("allow", "POST")], "").await;
    }
    let msg: Value = match serde_json::from_slice(&req.body) {
        Ok(v) => v,
        Err(_) => return respond(&mut stream, "400 Bad Request", &[], &rpc_error(Value::Null, -32700, "parse error").to_string()).await,
    };
    let caller = req.header("x-openterm-thread").map(str::to_string);
    match handle(msg, handler.as_ref(), caller).await {
        Some(reply) => respond(&mut stream, "200 OK", &[], &reply.to_string()).await,
        None => respond(&mut stream, "202 Accepted", &[], "").await,
    }
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// Answers one JSON-RPC message; None for notifications and responses.
pub async fn handle(msg: Value, handler: &dyn ToolHandler, caller: Option<String>) -> Option<Value> {
    if !msg.is_object() {
        return Some(rpc_error(Value::Null, -32600, "expected one JSON-RPC message"));
    }
    let id = msg.get("id").cloned()?;
    let Some(method) = msg.get("method").and_then(Value::as_str) else {
        return None; // a response to something we never sent
    };
    let params = msg.get("params").cloned().unwrap_or(Value::Null);
    let result = match method {
        "initialize" => {
            let asked = params.get("protocolVersion").and_then(Value::as_str).unwrap_or("");
            let version = PROTOCOLS.iter().find(|v| **v == asked).copied().unwrap_or(PROTOCOLS[0]);
            json!({
                "protocolVersion": version,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION") },
                "instructions": "OpenTerm, the app you run inside: its sessions, terminals, tasks, timers, panels and settings. Use these tools when the user asks about or wants changes in OpenTerm itself.",
            })
        }
        "ping" => json!({}),
        "tools/list" => json!({ "tools": handler.tools() }),
        "tools/call" => {
            let Some(name) = params.get("name").and_then(Value::as_str) else {
                return Some(rpc_error(id, -32602, "missing tool name"));
            };
            if !handler.tools().iter().any(|t| t.get("name").and_then(Value::as_str) == Some(name)) {
                return Some(rpc_error(id, -32602, &format!("unknown tool {name}")));
            }
            let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            let out = handler.call(name.to_string(), args, caller).await;
            json!({ "content": [{ "type": "text", "text": out.text }], "isError": out.is_error })
        }
        _ => return Some(rpc_error(id, -32601, &format!("method {method} not found"))),
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}


// ------------------------------------------------------------ webview relay

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

/// Tools are defined and run in the webview (one tool system for the Agents
/// assistant, voice and threads); the server only relays calls to it.
pub struct WebviewTools {
    app: AppHandle,
    tools: Mutex<Vec<Value>>,
    pending: Mutex<HashMap<String, oneshot::Sender<ToolOutcome>>>,
    next: AtomicU64,
}

impl ToolHandler for WebviewTools {
    fn tools(&self) -> Vec<Value> {
        self.tools.lock().unwrap().clone()
    }

    fn call(&self, name: String, arguments: Value, caller: Option<String>) -> ToolFuture {
        let id = format!("c{}", self.next.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id.clone(), tx);
        let _ = self.app.emit("app-mcp-call", json!({ "id": id, "name": name, "arguments": arguments, "caller": caller }));
        Box::pin(async move {
            match tokio::time::timeout(std::time::Duration::from_secs(600), rx).await {
                Ok(Ok(out)) => out,
                _ => ToolOutcome { text: "OpenTerm didn't answer in time.".into(), is_error: true },
            }
        })
    }
}

struct Running {
    server: McpServer,
    tools: Arc<WebviewTools>,
}

fn running() -> &'static Mutex<Option<Running>> {
    static R: std::sync::OnceLock<Mutex<Option<Running>>> = std::sync::OnceLock::new();
    R.get_or_init(|| Mutex::new(None))
}

/// Starts the server once (later calls just refresh the tool list) and
/// returns the `--mcp-config` document for Claude Code.
#[tauri::command]
pub async fn app_mcp_start(app: AppHandle, tools: Vec<Value>) -> Result<Value, String> {
    if let Some(r) = running().lock().unwrap().as_ref() {
        *r.tools.tools.lock().unwrap() = tools;
        return Ok(r.server.claude_config());
    }
    let handler = Arc::new(WebviewTools { app, tools: Mutex::new(tools), pending: Mutex::new(HashMap::new()), next: AtomicU64::new(1) });
    let server = McpServer::start(handler.clone()).await.map_err(|e| format!("Couldn't start OpenTerm's tool server: {e}"))?;
    let config = server.claude_config();
    let mut slot = running().lock().unwrap();
    if let Some(r) = slot.as_ref() {
        return Ok(r.server.claude_config());
    }
    *slot = Some(Running { server, tools: handler });
    Ok(config)
}

/// The webview's answer to an `app-mcp-call` event.
#[tauri::command]
pub fn app_mcp_result(id: String, text: String, is_error: bool) {
    let tx = running().lock().unwrap().as_ref().and_then(|r| r.tools.pending.lock().unwrap().remove(&id));
    if let Some(tx) = tx {
        let _ = tx.send(ToolOutcome { text, is_error });
    }
}
