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
    crate::stt::keys::get_groq_key().is_some()
        || crate::stt::keys::get_openrouter_key().is_some()
}

fn language_hint() -> Option<String> {
    crate::stt::keys::config_string("dictation_locale")
        .filter(|locale| locale.len() >= 2)
        .map(|locale| locale[..2].to_ascii_lowercase())
}

/// Groq-hosted Whisper — same model family, served far faster than the
/// OpenRouter route (the transcription leg was the bulk of the operator's
/// 4–6s release-to-paste lag). Tried FIRST when a Groq key is configured;
/// any failure falls through to the OpenRouter/managed path so the pass is
/// never worse than before.
const GROQ_TRANSCRIPTION_URL: &str = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_WHISPER_MODEL: &str = "whisper-large-v3-turbo";

#[derive(Debug, Deserialize)]
struct GroqTranscriptionResponse {
    text: Option<String>,
}

fn transcribe_via_groq(path: &str, audio: Vec<u8>, key: &str) -> Option<WhisperTranscription> {
    let file_name = Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("audio.wav")
        .to_string();
    let mut form = reqwest::blocking::multipart::Form::new()
        .part(
            "file",
            reqwest::blocking::multipart::Part::bytes(audio).file_name(file_name),
        )
        .text("model", GROQ_WHISPER_MODEL)
        .text("temperature", "0")
        .text("response_format", "json");
    if let Some(language) = language_hint() {
        form = form.text("language", language);
    }

    let start = Instant::now();
    let response = client()
        .post(GROQ_TRANSCRIPTION_URL)
        .header("Authorization", format!("Bearer {key}"))
        .multipart(form)
        .send();

    match response {
        Ok(response) if response.status().is_success() => {
            let latency_ms = start.elapsed().as_millis() as u64;
            match response.json::<GroqTranscriptionResponse>() {
                Ok(parsed) => {
                    let text = parsed.text.unwrap_or_default().trim().to_string();
                    if text.is_empty() {
                        tracing::warn!("Groq Whisper returned an empty transcript");
                        return None;
                    }
                    tracing::info!(
                        "[stt] groq whisper ok: {} chars in {latency_ms}ms",
                        text.len()
                    );
                    Some(WhisperTranscription {
                        text,
                        model: format!("groq/{GROQ_WHISPER_MODEL}"),
                        latency_ms,
                        seconds: None,
                        estimated_cost_usd: None,
                    })
                }
                Err(e) => {
                    tracing::warn!("Groq Whisper parse error: {e}");
                    None
                }
            }
        }
        Ok(response) => {
            tracing::warn!("Groq Whisper HTTP {}", response.status());
            None
        }
        Err(e) => {
            tracing::warn!("Groq Whisper request failed: {e}");
            None
        }
    }
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
    let audio = match std::fs::read(path) {
        Ok(audio) => audio,
        Err(e) => {
            tracing::warn!("Whisper Turbo STT skipped: failed to read audio file {path}: {e}");
            return None;
        }
    };

    // Groq first — fastest whisper serving available; falls through on any
    // failure so a bad Groq key never breaks the pass.
    if let Some(groq_key) = crate::stt::keys::get_groq_key() {
        if !audio.is_empty() {
            if let Some(result) = transcribe_via_groq(path, audio.clone(), &groq_key) {
                return Some(result);
            }
            tracing::warn!("Groq Whisper failed — falling back to OpenRouter/managed route");
        }
    }

    // local OpenRouter key → direct; else an active o8 plan → managed proxy.
    let target = match crate::entitlement::resolve_transcribe() {
        Some(t) => t,
        None => {
            tracing::warn!("Whisper Turbo STT skipped: no OpenRouter key and no active o8 plan");
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
        .post(&target.url)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", target.bearer))
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
