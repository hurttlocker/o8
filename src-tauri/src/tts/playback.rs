//! Audio playback for TTS — the MANDATORY `!Send` rodio thread pattern.
//!
//! `rodio::OutputStream`/`Sink`/`Decoder` are `!Send` and held across `.await`,
//! so they CANNOT run on Tauri's multithread async runtime (`async_runtime::
//! spawn`) — it won't compile. Every playback runs on a DEDICATED OS thread with
//! a `new_current_thread` tokio runtime built INSIDE it; synthesis (async
//! reqwest) and decode/play happen on that same thread, never crossing a
//! boundary. Ported from aqua `reading.rs:157-189` + `:267-330`.

use super::TtsConfig;

/// Speak `text` with `config` on a dedicated OS thread (fire-and-forget). On a
/// cloud-provider failure, falls back to the macOS `say` binary so the user
/// always hears something. Returns immediately; playback happens off-thread.
pub fn play_thread(text: String, config: TtsConfig) {
    if text.trim().is_empty() {
        return;
    }
    std::thread::spawn(move || {
        // Current-thread tokio runtime, built INSIDE this OS thread so the
        // !Send rodio handles never cross a thread boundary.
        let rt = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(rt) => rt,
            Err(e) => {
                tracing::error!("[tts] failed to build playback runtime: {e}");
                return;
            }
        };

        // 1) Synthesize (async reqwest) on this thread's runtime.
        let mp3 = match rt.block_on(async { super::speak(&text, &config).await }) {
            Ok(bytes) => bytes,
            Err(e) => {
                // Provider failed → speak the whole text once via `say`.
                tracing::warn!("[tts] provider failed ({e}); falling back to `say`");
                super::native_say::speak_with_say(&text, config.speed);
                return;
            }
        };

        // 2) Decode + play on the SAME OS thread.
        let (_stream, handle) = match rodio::OutputStream::try_default() {
            Ok(s) => s,
            Err(e) => {
                tracing::error!("[tts] no audio output device: {e}");
                return;
            }
        };
        let sink = match rodio::Sink::try_new(&handle) {
            Ok(s) => s,
            Err(e) => {
                tracing::error!("[tts] failed to create audio sink: {e}");
                return;
            }
        };
        match rodio::Decoder::new(std::io::Cursor::new(mp3)) {
            Ok(decoder) => sink.append(decoder),
            Err(e) => {
                tracing::error!("[tts] failed to decode audio: {e}");
                return;
            }
        }
        sink.sleep_until_end();
    });
}
