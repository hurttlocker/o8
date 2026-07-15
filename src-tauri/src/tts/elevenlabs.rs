//! ElevenLabs text-to-speech (ported from aqua/Symon `tts/elevenlabs.rs`,
//! de-Symonized). DIRECT to api.elevenlabs.io — there is NO proxy. The key is
//! resolved un-gated via `stt::keys::get_elevenlabs_key()` (env-first →
//! macOS Keychain); its PRESENCE is the de-facto premium gate.
//!
//! Returns raw MP3 bytes for `playback::play_thread` to decode + play.

use serde::Serialize;

use super::TtsConfig;

const ENDPOINT_BASE: &str = "https://api.elevenlabs.io/v1/text-to-speech";
const DEFAULT_VOICE: &str = "JBFqnCBsd6RMkjVDRZzb";
const DEFAULT_MODEL: &str = "eleven_multilingual_v2";
const DEFAULT_OUTPUT_FORMAT: &str = "mp3_44100_128";

// NOTE: snake_case AS-IS — the ElevenLabs API literally wants `model_id` /
// `voice_settings` / `similarity_boost` / `use_speaker_boost`. Do NOT add a
// `rename_all` attribute here (unlike the Google path).
#[derive(Serialize)]
struct SynthesizeRequest {
    text: String,
    model_id: String,
    voice_settings: VoiceSettings,
}

#[derive(Serialize)]
struct VoiceSettings {
    stability: f32,
    similarity_boost: f32,
    style: f32,
    use_speaker_boost: bool,
    /// Native, PITCH-PRESERVING speed. ElevenLabs supports 0.7–1.2 (1.0 =
    /// normal); outside that it 422s. We clamp before sending. This replaces
    /// the old rodio `set_speed` hack, which resampled and shifted pitch
    /// (2× = chipmunk) — operator-rejected 2026-06-11.
    speed: f32,
}

/// A tuning value resolved env-first (matching o8's key convention), then the
/// `~/.o8/dictation.json` config, then the default.
fn pref_or_env(pref_key: &str, env_key: &str, default_value: &str) -> String {
    std::env::var(env_key)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| crate::stt::keys::config_string(pref_key))
        .unwrap_or_else(|| default_value.to_string())
}

fn pref_or_env_f32(pref_key: &str, env_key: &str, default_value: f32) -> f32 {
    pref_or_env(pref_key, env_key, "")
        .parse::<f32>()
        .ok()
        .filter(|value| (0.0..=1.0).contains(value))
        .unwrap_or(default_value)
}

fn pref_or_env_bool(pref_key: &str, env_key: &str, default_value: bool) -> bool {
    match pref_or_env(pref_key, env_key, "").as_str() {
        "true" | "1" | "yes" => true,
        "false" | "0" | "no" => false,
        _ => default_value,
    }
}

pub fn configured_voice_id() -> String {
    pref_or_env("elevenlabs_voice_id", "ELEVENLABS_VOICE_ID", DEFAULT_VOICE)
}

fn configured_model_id() -> String {
    pref_or_env("elevenlabs_model_id", "ELEVENLABS_MODEL_ID", DEFAULT_MODEL)
}

fn configured_output_format() -> String {
    pref_or_env(
        "elevenlabs_output_format",
        "ELEVENLABS_OUTPUT_FORMAT",
        DEFAULT_OUTPUT_FORMAT,
    )
}

fn error_message(status: reqwest::StatusCode, body: &str) -> String {
    let parsed = serde_json::from_str::<serde_json::Value>(body).ok();
    let detail = parsed.as_ref().and_then(|value| value.get("detail"));
    let message = detail
        .and_then(|value| value.get("message"))
        .and_then(|value| value.as_str())
        .or_else(|| detail.and_then(|value| value.as_str()))
        .or_else(|| {
            parsed
                .as_ref()
                .and_then(|value| value.get("message"))
                .and_then(|value| value.as_str())
        })
        .unwrap_or(body);

    format!("ElevenLabs TTS API error ({status}): {message}")
}

/// Synthesize `text` → MP3 bytes via ElevenLabs (direct). `config.speed` is sent
/// as the native, pitch-preserving `voice_settings.speed` (clamped to the
/// 0.7–1.2 range ElevenLabs accepts).
pub async fn synthesize(text: &str, config: &TtsConfig) -> Result<Vec<u8>, String> {
    let api_key = crate::stt::keys::get_elevenlabs_key()
        .ok_or_else(|| "Missing ELEVENLABS_API_KEY for ElevenLabs read-aloud".to_string())?;

    let voice_id = if config.voice_id.trim().is_empty() {
        configured_voice_id()
    } else {
        config.voice_id.clone()
    };
    let model_id = configured_model_id();
    let output_format = configured_output_format();
    let url = format!("{ENDPOINT_BASE}/{voice_id}?output_format={output_format}");

    let request_body = SynthesizeRequest {
        text: text.to_string(),
        model_id,
        voice_settings: VoiceSettings {
            stability: pref_or_env_f32("elevenlabs_stability", "ELEVENLABS_STABILITY", 0.45),
            similarity_boost: pref_or_env_f32(
                "elevenlabs_similarity_boost",
                "ELEVENLABS_SIMILARITY_BOOST",
                0.8,
            ),
            style: pref_or_env_f32("elevenlabs_style", "ELEVENLABS_STYLE", 0.0),
            use_speaker_boost: pref_or_env_bool(
                "elevenlabs_use_speaker_boost",
                "ELEVENLABS_USE_SPEAKER_BOOST",
                true,
            ),
            speed: config.speed.clamp(0.7, 1.2),
        },
    };

    let response = reqwest::Client::new()
        .post(&url)
        .header("xi-api-key", api_key)
        .header("Accept", "audio/mpeg")
        .json(&request_body)
        .send()
        .await
        .map_err(|e| format!("ElevenLabs TTS request failed: {e}"))?;

    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("ElevenLabs TTS response failed: {e}"))?;

    if !status.is_success() {
        let body = String::from_utf8_lossy(&bytes);
        return Err(error_message(status, &body));
    }
    if bytes.is_empty() {
        return Err("ElevenLabs TTS: received empty audio".to_string());
    }

    Ok(bytes.to_vec())
}
