//! Native text-to-speech engine (voice P4), ported from aqua/Symon `tts/` and
//! de-Symonized: DIRECT API keys only (no proxy / license / product-mode), the
//! dead Edge + Native(AVSpeechSynthesizer) providers omitted, errors are
//! `String`. Two real providers — ElevenLabs (premium, key-gated) and Google
//! (direct) — with the macOS `say` binary as the runtime fallback.
//!
//! Playback runs on a dedicated OS thread (see `playback` — the `!Send` rodio
//! constraint), so o8 can speak with no focused webview.

pub mod elevenlabs;
pub mod google;
pub mod native_say;
pub mod playback;

use std::sync::OnceLock;

/// App handle stored at setup() so the off-thread playback can morph the screen
/// dock while TTS plays (so it shows activity instead of sitting idle).
static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

/// Store the app handle once (called from setup, after the dock window exists).
pub fn set_app_handle(handle: tauri::AppHandle) {
    let _ = APP_HANDLE.set(handle);
}

/// The stored app handle, if setup has run. Used by `playback` to emit
/// `o8:tts-state` for the play/stop control surfaces.
pub(crate) fn app_handle() -> Option<&'static tauri::AppHandle> {
    APP_HANDLE.get()
}

/// Emit an `o8:stt-event` to the screen dock so it morphs while TTS plays.
/// Direct `emit_to(DOCK_LABEL)` (the reliable path) + broadcast. Thread-safe —
/// Tauri events can be emitted from any thread.
pub(crate) fn emit_dock(event_type: &str) {
    use tauri::Emitter;
    if let Some(app) = APP_HANDLE.get() {
        let payload = serde_json::json!({ "type": event_type, "origin": "system" });
        let _ = app.emit_to(crate::dock_window::DOCK_LABEL, "o8:stt-event", payload.clone());
        let _ = app.emit("o8:stt-event", payload);
    }
}

/// The two shipping providers. (Edge → remapped to Google in aqua, Native is a
/// perpetual stub — both omitted. `say` is the fallback, not a provider.)
pub enum TtsProvider {
    ElevenLabs,
    Google,
}

pub struct TtsConfig {
    pub provider: TtsProvider,
    pub voice_id: String,
    pub speed: f32,
    pub pitch: f32,
}

/// Resolve the active TTS config from prefs (`~/.o8/dictation.json`) + env.
/// ElevenLabs is selected only when `tts_provider == "elevenlabs"` AND an
/// ElevenLabs key resolves (its presence is the premium gate); everything else
/// (google / edge / native / unset) falls to Google. When no Google key
/// resolves either, the runtime fallback is the macOS `say` binary, so o8 always
/// has a working voice out of the box with zero config.
pub fn load_config() -> TtsConfig {
    let provider = match crate::stt::keys::config_string("tts_provider").as_deref() {
        Some("elevenlabs") if crate::stt::keys::get_elevenlabs_key().is_some() => {
            TtsProvider::ElevenLabs
        }
        _ => TtsProvider::Google,
    };

    let voice_id = match provider {
        // ElevenLabs always uses its own voice id (not the Google reading voice).
        TtsProvider::ElevenLabs => elevenlabs::configured_voice_id(),
        TtsProvider::Google => crate::stt::keys::config_string("tts_voice_id")
            .unwrap_or_else(|| "en-US-Neural2-J".to_string()),
    };

    let speed = crate::stt::keys::config_string("reading_speed")
        .and_then(|s| s.parse::<f32>().ok())
        .unwrap_or(1.0);

    TtsConfig {
        provider,
        voice_id,
        speed,
        pitch: 0.0,
    }
}

/// Synthesize `text` → MP3 bytes via the configured provider. Errors are
/// `String`; the `playback` layer falls back to `say` on error.
pub async fn speak(text: &str, config: &TtsConfig) -> Result<Vec<u8>, String> {
    match config.provider {
        TtsProvider::ElevenLabs => elevenlabs::synthesize(text, config).await,
        TtsProvider::Google => google::synthesize(text, config).await,
    }
}
