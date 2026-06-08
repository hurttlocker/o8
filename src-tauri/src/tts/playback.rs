//! Audio playback for TTS — the MANDATORY `!Send` rodio thread pattern.
//!
//! `rodio::OutputStream`/`Sink`/`Decoder` are `!Send` and held across `.await`,
//! so they CANNOT run on Tauri's multithread async runtime (`async_runtime::
//! spawn`) — it won't compile. Every playback runs on a DEDICATED OS thread with
//! a `new_current_thread` tokio runtime built INSIDE it; synthesis (async
//! reqwest) and decode/play happen on that same thread, never crossing a
//! boundary. Ported from aqua `reading.rs:157-189` + `:267-330`.
//!
//! Diagnostics use `log::` (NOT `tracing::`) so they reach the bundled-app log
//! at `~/Library/Logs/ai.o8.desktop/o8.log` (the tracing subscriber writes to
//! stdout, which a Finder-launched .app discards). EVERY failure path falls back
//! to the macOS `say` binary so the user always hears SOMETHING.

use super::TtsConfig;

/// Speak `text` with `config` on a dedicated OS thread (fire-and-forget). Any
/// failure (synth OR audio device OR decode) falls back to the macOS `say`
/// binary. Returns immediately; playback happens off-thread.
pub fn play_thread(text: String, config: TtsConfig) {
    if text.trim().is_empty() {
        return;
    }
    std::thread::spawn(move || {
        let speed = config.speed;
        log::info!("[tts] play_thread: {} chars, provider {:?}", text.len(), provider_label(&config));

        // Morph the screen dock to show TTS is active. The guard returns it to
        // idle on EVERY exit path (success, synth-fail→say, rodio-fail→say) so
        // the dock never gets stuck mid-morph.
        super::emit_dock("system-start");
        struct DockGuard;
        impl Drop for DockGuard {
            fn drop(&mut self) {
                super::emit_dock("system-idle");
            }
        }
        let _dock_guard = DockGuard;

        // Current-thread tokio runtime, built INSIDE this OS thread so the
        // !Send rodio handles never cross a thread boundary.
        let rt = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(rt) => rt,
            Err(e) => {
                log::error!("[tts] failed to build playback runtime: {e}; falling back to say");
                super::native_say::speak_with_say(&text, speed);
                return;
            }
        };

        // 1) Synthesize (async reqwest) on this thread's runtime.
        let mp3 = match rt.block_on(async { super::speak(&text, &config).await }) {
            Ok(bytes) => {
                log::info!("[tts] synth ok: {} mp3 bytes", bytes.len());
                bytes
            }
            Err(e) => {
                log::warn!("[tts] provider synth failed ({e}); falling back to say");
                super::native_say::speak_with_say(&text, speed);
                return;
            }
        };

        // 2) Decode + play on the SAME OS thread. ANY failure here → say.
        let (_stream, handle) = match rodio::OutputStream::try_default() {
            Ok(s) => s,
            Err(e) => {
                log::error!("[tts] no audio output device ({e}); falling back to say");
                super::native_say::speak_with_say(&text, speed);
                return;
            }
        };
        let sink = match rodio::Sink::try_new(&handle) {
            Ok(s) => s,
            Err(e) => {
                log::error!("[tts] failed to create audio sink ({e}); falling back to say");
                super::native_say::speak_with_say(&text, speed);
                return;
            }
        };
        match rodio::Decoder::new(std::io::Cursor::new(mp3)) {
            Ok(decoder) => sink.append(decoder),
            Err(e) => {
                log::error!("[tts] failed to decode audio ({e}); falling back to say");
                super::native_say::speak_with_say(&text, speed);
                return;
            }
        }
        log::info!("[tts] playing via rodio…");
        sink.sleep_until_end();
        log::info!("[tts] playback complete");
    });
}

fn provider_label(config: &TtsConfig) -> &'static str {
    match config.provider {
        super::TtsProvider::ElevenLabs => "ElevenLabs",
        super::TtsProvider::Google => "Google",
    }
}
