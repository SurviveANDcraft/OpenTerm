//! The Agents panel's assistant: one streamed, tool-capable chat-completion
//! turn against OpenRouter, plus the one-shot card summariser.
//!
//! The tool *loop* lives in the frontend on purpose — every tool reads a
//! terminal's rendered xterm buffer, which only exists in the webview. This
//! side does one round trip per call: stream the reply, forward text deltas as
//! they arrive, and hand back the assembled message (text + tool calls) with
//! the token/cost accounting OpenRouter reports.

use std::{
    collections::HashSet,
    sync::{Mutex, OnceLock},
    time::Duration,
};

use serde::Serialize;
use serde_json::Value;
use tauri::ipc::Channel;

const OPENROUTER_URL: &str = "https://openrouter.ai/api/v1/chat/completions";
const MODEL: &str = "deepseek/deepseek-v4-flash";
/// A whole turn (think + tool calls, or the final answer) has to land inside
/// this. Generous, because a long answer streams for a while, but bounded so a
/// stalled connection can't pin the panel in "thinking" forever.
const TURN_TIMEOUT_SECS: u64 = 90;
/// Replies are meant to be short status reports; the cap keeps a model that
/// starts writing an essay from burning tokens nobody asked for.
const MAX_REPLY_TOKENS: u32 = 1200;

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AssistantEvent {
    /// A fragment of the visible reply.
    Delta { text: String },
}

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    /// Raw JSON argument string, exactly as the model produced it.
    pub arguments: String,
}

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TurnUsage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub cached_tokens: u64,
    /// USD, as billed by OpenRouter. 0 when the provider didn't report it.
    pub cost: f64,
}

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AssistantTurn {
    pub content: String,
    pub tool_calls: Vec<ToolCall>,
    pub usage: TurnUsage,
    /// True when the user hit stop mid-stream; `content` holds what arrived.
    pub cancelled: bool,
}

fn cancelled_ids() -> &'static Mutex<HashSet<String>> {
    static IDS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    IDS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn take_cancel(request_id: &str) -> bool {
    cancelled_ids().lock().unwrap().remove(request_id)
}

/// Stops an in-flight `assistant_chat` at its next streamed chunk.
#[tauri::command]
pub fn assistant_cancel(request_id: String) {
    cancelled_ids().lock().unwrap().insert(request_id);
}

/// One streamed completion. `messages` and `tools` are OpenAI-format arrays
/// built by the frontend; they're passed through untouched so the prompt
/// layout (and with it the provider's prefix cache) stays under one owner.
#[tauri::command]
pub async fn assistant_chat(
    api_key: String,
    request_id: String,
    messages: Value,
    tools: Value,
    on_event: Channel<AssistantEvent>,
) -> Result<AssistantTurn, String> {
    // A stale flag from a stop pressed after the previous turn finished must
    // not kill this one.
    take_cancel(&request_id);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(TURN_TIMEOUT_SECS))
        .build()
        .map_err(|e| e.to_string())?;

    let mut body = serde_json::json!({
        "model": MODEL,
        "stream": true,
        "max_tokens": MAX_REPLY_TOKENS,
        "temperature": 0.2,
        "messages": messages,
        "usage": { "include": true },
    });
    if tools.as_array().is_some_and(|t| !t.is_empty()) {
        body["tools"] = tools;
    }

    let mut resp = client
        .post(OPENROUTER_URL)
        .bearer_auth(api_key.trim())
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        let v: Value = resp.json().await.unwrap_or(Value::Null);
        let detail = v["error"]["message"].as_str().unwrap_or("");
        return Err(format!("OpenRouter {} {}", status.as_u16(), detail));
    }

    let mut turn = AssistantTurn::default();
    let mut pending = String::new();
    loop {
        if take_cancel(&request_id) {
            turn.cancelled = true;
            break;
        }
        let chunk = match resp.chunk().await {
            Ok(Some(c)) => c,
            Ok(None) => break,
            Err(e) => return Err(format!("stream interrupted: {e}")),
        };
        pending.push_str(&String::from_utf8_lossy(&chunk));
        // SSE: one `data:` line per event; a chunk can end mid-line, so only
        // complete lines are consumed and the remainder waits for the next.
        while let Some(nl) = pending.find('\n') {
            let line: String = pending.drain(..=nl).collect();
            let line = line.trim();
            let Some(data) = line.strip_prefix("data:") else {
                continue; // blank separators and ": OPENROUTER PROCESSING" keep-alives
            };
            let data = data.trim();
            if data == "[DONE]" {
                continue;
            }
            let Ok(v) = serde_json::from_str::<Value>(data) else {
                continue;
            };
            if let Some(msg) = v["error"]["message"].as_str() {
                return Err(format!("OpenRouter: {msg}"));
            }
            apply_chunk(&v, &mut turn, &on_event);
        }
    }

    turn.tool_calls.retain(|c| !c.name.is_empty());
    // Some providers stream calls without ids; the follow-up tool messages
    // still need one to answer each call by.
    for (i, c) in turn.tool_calls.iter_mut().enumerate() {
        if c.id.is_empty() {
            c.id = format!("call_{i}");
        }
    }
    turn.content = turn.content.trim().to_string();
    Ok(turn)
}

/// Folds one streamed chunk into the turn: text is forwarded live, tool-call
/// fragments are stitched together by index (the id and name arrive on the
/// first fragment, the JSON arguments across many).
fn apply_chunk(v: &Value, turn: &mut AssistantTurn, on_event: &Channel<AssistantEvent>) {
    let delta = &v["choices"][0]["delta"];
    if let Some(text) = delta["content"].as_str() {
        if !text.is_empty() {
            turn.content.push_str(text);
            let _ = on_event.send(AssistantEvent::Delta { text: text.to_string() });
        }
    }
    if let Some(calls) = delta["tool_calls"].as_array() {
        for c in calls {
            let idx = c["index"].as_u64().unwrap_or(turn.tool_calls.len() as u64) as usize;
            while turn.tool_calls.len() <= idx {
                turn.tool_calls.push(ToolCall::default());
            }
            let slot = &mut turn.tool_calls[idx];
            if let Some(id) = c["id"].as_str() {
                slot.id = id.to_string();
            }
            if let Some(name) = c["function"]["name"].as_str() {
                slot.name.push_str(name);
            }
            if let Some(args) = c["function"]["arguments"].as_str() {
                slot.arguments.push_str(args);
            }
        }
    }
    let u = &v["usage"];
    if u.is_object() {
        turn.usage = TurnUsage {
            prompt_tokens: u["prompt_tokens"].as_u64().unwrap_or(0),
            completion_tokens: u["completion_tokens"].as_u64().unwrap_or(0),
            cached_tokens: u["prompt_tokens_details"]["cached_tokens"].as_u64().unwrap_or(0),
            cost: u["cost"].as_f64().unwrap_or(0.0),
        };
    }
}

/// Names what an agent was asked to do and what it's doing now, for its card.
/// Returns the model's JSON text; the frontend parses it leniently.
#[tauri::command]
pub async fn summarize_agent(api_key: String, context: String) -> Result<String, String> {
    const SYSTEM: &str = "You label AI coding-agent terminals for a dashboard. You get the user's last prompt to the agent (may be missing) and the tail of the agent's terminal screen. Reply with ONLY a JSON object: {\"task\": string, \"now\": string}. \"task\" names what the user asked for, imperative, at most 7 words (e.g. \"Fix login redirect loop\"); if the prompt is missing infer it from the screen, or use \"\" if you can't. \"now\" says what the agent is doing or where it stands right now, at most 10 words (e.g. \"Running tests, 2 failing\", \"Done, waiting for review\", \"Asking permission to run git push\"). Use only what the input shows; never invent files or results. No markdown, no em dashes.";
    crate::openrouter_chat(&api_key, SYSTEM, &context, 120, 20).await
}
