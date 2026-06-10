//! Optional Whisper Turbo STT pass (operator-required, default-on).
//!
//! Apple Speech still owns live partial transcripts. When this pass is enabled
//! (it is, by default), o8 sends the saved WAV through OpenRouter and uses
//! Whisper's final transcript as the raw text for the existing polish path. On
//! failure or an empty result it falls back to Apple's transcript.
//!
//! De-Symonized: the Symon proxy route + license token are gone. The only
//! route is a direct call to OpenRouter using `get_openrouter_key()`
//! (env-first), which works in release builds.

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

pub const WHISPER_TURBO_MODEL: &str = "openai/whisper-large-v3-turbo";

const DIRECT_OPENROUTER_ENDPOINT: &str = "https://openrouter.ai/api/v1/audio/transcriptions";
const TIMEOUT_SECS: u64 = 30;

static CLIENT: OnceLock<reqwest::blocking::Client> = OnceLock::new();

#[derive(Debug, Clone, Serialize)]
pub struct WhisperTranscription {
    pub text: String,
    pub model: String,
    pub latency_ms: u64,
    pub seconds: Option<f64>,
    pub estimated_cost_usd: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct OpenRouterTranscriptionResponse {
    text: Option<String>,
    model: Option<String>,
    usage: Option<OpenRouterTranscriptionUsage>,
    error: Option<OpenRouterError>,
}

#[derive(Debug, Deserialize)]
struct OpenRouterTranscriptionUsage {
    seconds: Option<f64>,
    cost: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct OpenRouterError {
    message: Option<String>,
}

fn client() -> &'static reqwest::blocking::Client {
    CLIENT.get_or_init(|| {
        reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(TIMEOUT_SECS))
            .connect_timeout(Duration::from_secs(10))
            .pool_idle_timeout(Duration::from_secs(300))
            .pool_max_idle_per_host(4)
            .http2_adaptive_window(true)
            .build()
            .unwrap_or_else(|e| {
                tracing::warn!(
                    "Failed to build shared Whisper STT client ({e}), falling back to default"
                );
                reqwest::blocking::Client::new()
            })
    })
}

fn truthy(value: Option<String>) -> bool {
    matches!(value.as_deref(), Some("true" | "1"))
}

/// Whether the Whisper re-transcription pass runs. DEFAULT TRUE.
///
/// Override order: `O8_WHISPER_STT_ENABLED=1` force-on, then the o8 config
/// pref `whisper_stt_enabled` (any value other than `"false"`/`"0"` keeps it
/// on). There is NO product-mode gate — the operator requires this pass on.
pub fn enabled() -> bool {
    if truthy(std::env::var("O8_WHISPER_STT_ENABLED").ok()) {
        return true;
    }
    !matches!(
        crate::stt::keys::config_string("whisper_stt_enabled").as_deref(),
        Some("false" | "0")
    )
}

pub fn is_available() -> bool {
    crate::stt::keys::get_openrouter_key().is_some()
}

fn language_hint() -> Option<String> {
    crate::stt::keys::config_string("dictation_locale")
        .filter(|locale| locale.len() >= 2)
        .map(|locale| locale[..2].to_ascii_lowercase())
}

fn audio_format(path: &str) -> String {
    Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .filter(|ext| !ext.is_empty())
        .unwrap_or("wav")
        .to_ascii_lowercase()
}

pub fn transcribe_file(path: &str) -> Option<WhisperTranscription> {
    let api_key = match crate::stt::keys::get_openrouter_key() {
        Some(key) => key,
        None => {
            tracing::warn!("Whisper Turbo STT skipped: missing OPENROUTER_API_KEY");
            return None;
        }
    };

    let audio = match std::fs::read(path) {
        Ok(audio) => audio,
        Err(e) => {
            tracing::warn!("Whisper Turbo STT skipped: failed to read audio file {path}: {e}");
            return None;
        }
    };

    if audio.is_empty() {
        tracing::warn!("Whisper Turbo STT skipped: audio file is empty");
        return None;
    }

    let mut body = serde_json::json!({
        "model": WHISPER_TURBO_MODEL,
        "input_audio": {
            "data": base64::engine::general_purpose::STANDARD.encode(audio),
            "format": audio_format(path),
        },
        "temperature": 0,
    });
    if let Some(language) = language_hint() {
        body["language"] = serde_json::Value::String(language);
    }

    let start = Instant::now();
    let request = client()
        .post(DIRECT_OPENROUTER_ENDPOINT)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {api_key}"))
        .header("HTTP-Referer", "https://github.com/hurttlocker/o8")
        .header("X-Title", "o8")
        .json(&body);

    let response = request.send();

    match response {
        Ok(response) if response.status().is_success() => {
            let latency_ms = start.elapsed().as_millis() as u64;
            match response.json::<OpenRouterTranscriptionResponse>() {
                Ok(parsed) => {
                    if let Some(error) = parsed.error {
                        tracing::warn!(
                            "Whisper Turbo STT API error: {}",
                            error.message.unwrap_or_else(|| "unknown error".to_string())
                        );
                        return None;
                    }

                    let text = parsed.text.unwrap_or_default().trim().to_string();
                    if text.is_empty() {
                        tracing::warn!("Whisper Turbo STT returned an empty transcript");
                        return None;
                    }

                    Some(WhisperTranscription {
                        text,
                        model: parsed
                            .model
                            .unwrap_or_else(|| WHISPER_TURBO_MODEL.to_string()),
                        latency_ms,
                        seconds: parsed.usage.as_ref().and_then(|usage| usage.seconds),
                        estimated_cost_usd: parsed.usage.and_then(|usage| usage.cost),
                    })
                }
                Err(e) => {
                    tracing::warn!("Whisper Turbo STT parse error: {e}");
                    None
                }
            }
        }
        Ok(response) => {
            let status = response.status();
            let body_text = response.text().unwrap_or_default();
            tracing::warn!(
                "Whisper Turbo STT API error ({status}): {}",
                crate::utf8_head(&body_text, 200)
            );
            None
        }
        Err(e) => {
            tracing::warn!("Whisper Turbo STT request failed: {e}");
            None
        }
    }
}
