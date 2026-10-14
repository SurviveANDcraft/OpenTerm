//! What the frontend can do with keys: ask whether one is saved, save one,
//! remove one, test one. Nothing here hands a saved key back.

use std::collections::HashMap;
use std::time::Duration;

use tauri::AppHandle;

use super::{hint, KeyInfo, Secret, Vault};

/// Where each key is stored and a few characters of it, or null when there's none.
#[tauri::command]
pub fn secrets_status(app: AppHandle) -> Result<HashMap<Secret, Option<KeyInfo>>, String> {
    let vault = Vault::new(&app)?;
    Ok(Secret::ALL.into_iter().map(|s| (s, vault.status(s))).collect())
}

#[tauri::command]
pub async fn secret_set(app: AppHandle, name: Secret, value: String) -> Result<KeyInfo, String> {
    let vault = Vault::new(&app)?;
    let info = tauri::async_runtime::spawn_blocking(move || {
        let storage = vault.set(name, &value)?;
        Ok::<_, String>(KeyInfo { storage, hint: hint(value.trim()) })
    })
    .await
    .map_err(|e| e.to_string())??;
    crate::dictation::host::key_changed();
    Ok(info)
}

#[tauri::command]
pub async fn secret_clear(app: AppHandle, name: Secret) -> Result<(), String> {
    let vault = Vault::new(&app)?;
    tauri::async_runtime::spawn_blocking(move || vault.clear(name))
        .await
        .map_err(|e| e.to_string())??;
    crate::dictation::host::key_changed();
    Ok(())
}

/// Checks a key against its provider: the one typed in Settings when `value`
/// is given, otherwise the saved one. Neither check runs a model, so it costs
/// nothing. Returns the key's name in the provider's account when it has one;
/// errors carry the provider's own message.
#[tauri::command]
pub async fn secret_test(app: AppHandle, name: Secret, value: Option<String>) -> Result<Option<String>, String> {
    let key = match value.map(|v| v.trim().to_string()).filter(|v| !v.is_empty()) {
        Some(v) => v,
        None => Vault::new(&app)?.require(name)?,
    };
    match name {
        Secret::OpenRouter => {
            let resp = client(20)?
                .get("https://openrouter.ai/api/v1/key")
                .bearer_auth(key)
                .send()
                .await
                .map_err(|e| format!("request failed: {e}"))?;
            let status = resp.status();
            let v: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
            if !status.is_success() {
                let detail = v["error"]["message"].as_str().unwrap_or("");
                return Err(format!("OpenRouter {} {}", status.as_u16(), detail).trim().to_string());
            }
            let label = v["data"]["label"].as_str().map(str::trim).filter(|l| !l.is_empty());
            Ok(label.map(str::to_string))
        }
        Secret::Gemini => {
            // Listing models costs nothing and fails the same way a bad key would.
            let resp = client(20)?
                .get("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1")
                .header("x-goog-api-key", key)
                .send()
                .await
                .map_err(|e| format!("request failed: {e}"))?;
            gemini_ok(resp).await?;
            Ok(None)
        }
    }
}

/// A single-use Gemini Live token, so the voice session in the webview can
/// connect without ever holding the API key. Good for starting one session in
/// the next two minutes; the session itself may resume on it for 30 minutes.
/// The voice view asks for a fresh one on every (re)connect.
#[tauri::command]
pub async fn gemini_live_token(app: AppHandle) -> Result<String, String> {
    let key = Vault::new(&app)?.require(Secret::Gemini)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let body = serde_json::json!({
        "uses": 1,
        "expireTime": crate::rfc3339_utc(now + 30 * 60),
        "newSessionExpireTime": crate::rfc3339_utc(now + 2 * 60),
    });
    let resp = client(15)?
        .post("https://generativelanguage.googleapis.com/v1beta/auth_tokens")
        .header("x-goog-api-key", key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    let v = gemini_ok(resp).await?;
    v["name"]
        .as_str()
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "Gemini returned no token".into())
}

fn client(timeout_secs: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .build()
        .map_err(|e| e.to_string())
}

/// The JSON body of a successful Gemini response, or Google's error message.
async fn gemini_ok(resp: reqwest::Response) -> Result<serde_json::Value, String> {
    let status = resp.status();
    let v: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
    if status.is_success() {
        return Ok(v);
    }
    Err(v["error"]["message"]
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| format!("HTTP {}", status.as_u16())))
}
