//! macOS `say` runtime fallback (ported from aqua/Symon `reading.rs`). The real
//! macOS-native TTS path — used when the cloud provider (ElevenLabs/Google)
//! errors or no key resolves. Synchronous (blocks until the utterance finishes).

/// Speak `text` via the macOS `say` binary at `175 * speed` words/min. Returns
/// whether it ran successfully. macOS only.
#[cfg(target_os = "macos")]
pub fn speak_with_say(text: &str, speed: f32) -> bool {
    let rate = (175.0 * speed.max(0.1)) as u32;
    matches!(
        std::process::Command::new("say")
            .args(["-r", &rate.to_string()])
            .arg(text)
            .status(),
        Ok(status) if status.success()
    )
}

#[cfg(not(target_os = "macos"))]
pub fn speak_with_say(_text: &str, _speed: f32) -> bool {
    false
}
