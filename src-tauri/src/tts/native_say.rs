//! macOS `say` runtime fallback (ported from aqua/Symon `reading.rs`). The real
//! macOS-native TTS path — used when the cloud provider (ElevenLabs/Google)
//! errors or no key resolves.
//!
//! `say` runs as a separate OS process. To stay single-flight-aware (so `stop()`
//! / a new speak can silence it like any rodio playback), it is `spawn`ed (not
//! `.status()`) and polled with a `should_cancel` predicate — when the
//! generation moves on, the child is killed mid-utterance instead of talking to
//! completion over the top of newer audio.

/// The macOS `say` floor should still sound like the product — MALE, never the
/// system default (often a woman's voice, the "choppy female" a keyless free
/// machine used to read back in, Q report 2026-07-15). Probe the installed
/// voices ONCE and pick the first present male en-US/en-GB voice; fall back to
/// the system default only if none of them is installed (so we never pass a
/// missing `-v` name, which would speak silence).
#[cfg(target_os = "macos")]
fn preferred_male_voice() -> Option<&'static str> {
    use std::sync::OnceLock;
    static VOICE: OnceLock<Option<&'static str>> = OnceLock::new();
    *VOICE.get_or_init(|| {
        // en-US male first (matches Steffan's accent), then en-GB male.
        const CANDIDATES: &[&str] = &["Alex", "Aaron", "Fred", "Tom", "Daniel", "Arthur", "Oliver"];
        let listing = std::process::Command::new("say")
            .args(["-v", "?"])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
            .unwrap_or_default();
        // `say -v '?'` lines start with the voice name, e.g.
        // "Alex                en_US    # Most people recognize me by my voice."
        let installed: Vec<&str> = listing
            .lines()
            .filter_map(|line| line.split_whitespace().next())
            .collect();
        CANDIDATES.iter().copied().find(|c| installed.contains(c))
    })
}

/// Speak `text` via the macOS `say` binary at `175 * speed` words/min, polling
/// `should_cancel` (~every 100ms) so a stop / new speak can interrupt it. The
/// `say` child is killed mid-utterance when `should_cancel()` returns true.
/// Returns whether it ran (to completion OR cancelled); `false` only if the
/// process could not be spawned/waited. macOS only.
#[cfg(target_os = "macos")]
pub fn speak_with_say_cancellable(
    text: &str,
    speed: f32,
    should_cancel: &dyn Fn() -> bool,
) -> bool {
    use std::time::Duration;
    let rate = (175.0 * speed.max(0.1)) as u32;
    let mut command = std::process::Command::new("say");
    command.args(["-r", &rate.to_string()]);
    if let Some(voice) = preferred_male_voice() {
        command.args(["-v", voice]);
    }
    let mut child = match command
        .arg(text)
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            log::error!("[tts] say spawn failed: {e}");
            return false;
        }
    };
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) => {
                if should_cancel() {
                    let _ = child.kill();
                    let _ = child.wait();
                    return true;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => {
                log::error!("[tts] say wait failed: {e}");
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub fn speak_with_say_cancellable(
    _text: &str,
    _speed: f32,
    _should_cancel: &dyn Fn() -> bool,
) -> bool {
    false
}
