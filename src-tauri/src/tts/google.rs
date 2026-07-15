//! Google Cloud TTS (ported from aqua/Symon `tts/google.rs`, de-Symonized to the
//! DIRECT branch only — the Symon proxy / license-token half is deleted). Key
//! via `stt::keys::get_google_tts_key()` (env-first → macOS Keychain).
//! Returns MP3 bytes.

use serde::{Deserialize, Serialize};

use super::TtsConfig;

const ENDPOINT: &str = "https://texttospeech.googleapis.com/v1/text:synthesize";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SynthesizeRequest {
    input: SynthesisInput,
    voice: VoiceSelection,
    audio_config: AudioConfig,
}

#[derive(Serialize)]
struct SynthesisInput {
    text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VoiceSelection {
    language_code: String,
    name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioConfig {
    audio_encoding: String,
    speaking_rate: f32,
    pitch: f32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SynthesizeResponse {
    audio_content: String,
}

#[derive(Deserialize)]
struct ApiError {
    error: ApiErrorDetail,
}

#[derive(Deserialize)]
struct ApiErrorDetail {
    message: String,
}

/// Synthesize `text` → MP3 bytes via Google Cloud TTS (direct).
pub async fn synthesize(text: &str, config: &TtsConfig) -> Result<Vec<u8>, String> {
    // Extract language code from the voice id (e.g. "en-US-Neural2-J" -> "en-US").
    let language_code = config
        .voice_id
        .split('-')
        .take(2)
        .collect::<Vec<_>>()
        .join("-");

    // Chirp 3 HD voices reject pitch adjustments — send 0.0 for them.
    let effective_pitch = if config.voice_id.contains("Chirp3") {
        0.0
    } else {
        config.pitch
    };

    let request_body = SynthesizeRequest {
        input: SynthesisInput {
            text: text.to_string(),
        },
        voice: VoiceSelection {
            language_code,
            name: config.voice_id.clone(),
        },
        audio_config: AudioConfig {
            audio_encoding: "MP3".into(),
            // Pitch-preserving server-side rate (Google supports 0.25–4.0; the
            // UI band is 0.7–1.2 to match ElevenLabs' pitch-preserving range).
            speaking_rate: config.speed.clamp(0.7, 1.2),
            pitch: effective_pitch,
        },
    };

    let api_key = crate::stt::keys::get_google_tts_key().ok_or_else(|| {
        "Missing GOOGLE_TTS_API_KEY — add it in Voice settings or the environment".to_string()
    })?;

    let response = reqwest::Client::new()
        .post(ENDPOINT)
        .header("x-goog-api-key", api_key)
        .json(&request_body)
        .send()
        .await
        .map_err(|e| format!("Google TTS request failed: {e}"))?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let message = serde_json::from_str::<ApiError>(&body)
            .map(|e| e.error.message)
            .unwrap_or(body);
        return Err(format!("Google TTS API error ({status}): {message}"));
    }

    let result: SynthesizeResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Google TTS response: {e}"))?;

    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(&result.audio_content)
        .map_err(|e| format!("Failed to decode audio content: {e}"))
}
