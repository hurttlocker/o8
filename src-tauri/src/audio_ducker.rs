//! System-wide audio ducking for voice dictation (Symon parity, #1207).
//!
//! When the user holds Fn (or Right-Option for Ask) to dictate, lower macOS's
//! system output volume so the microphone can hear over whatever's playing —
//! crucially, over o8's OWN TTS when the user wants to talk back while it's
//! still speaking. Restore the original level when the dictation ends.
//!
//! Uses `osascript` to drive the system volume. Core Audio would be cleaner but
//! pulls in an FFI dependency for what is a 2-line shell-out. Ported from
//! aqua/Symon `audio_ducker.rs`.

use std::sync::Mutex;

/// The lower bound we clamp the system volume to while dictating, as a fraction
/// of the user's pre-duck volume.
const DUCK_SCALAR: f32 = 0.20;

/// Remembers the volume in place *before* we started ducking. None = not
/// currently ducked. Only the first duck call stores a value; repeated duck
/// calls are no-ops so we never overwrite the baseline with the already-ducked
/// reading.
static SAVED_VOLUME: Mutex<Option<u32>> = Mutex::new(None);

/// Read the current macOS output volume as an integer 0-100.
#[cfg(target_os = "macos")]
fn read_output_volume() -> Option<u32> {
    let out = std::process::Command::new("osascript")
        .args(["-e", "output volume of (get volume settings)"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    s.trim().parse::<u32>().ok()
}

/// Set the macOS output volume. Clamped to 0-100.
#[cfg(target_os = "macos")]
fn set_output_volume(v: u32) {
    let clamped = v.min(100);
    let cmd = format!("set volume output volume {clamped}");
    let _ = std::process::Command::new("osascript")
        .args(["-e", &cmd])
        .output();
}

/// Lower the system volume so dictation audio is clearer. Safe to call
/// repeatedly; only the first call since the last `restore()` takes effect.
///
/// Fire-and-forget on a detached thread — the two `osascript` shell-outs cost
/// hundreds of ms (process spawn + AppleScript compile + IPC to the volume
/// server), and ducking is comfort, not correctness, so the Fn press path must
/// not block on it before STT can start.
pub fn duck() {
    #[cfg(target_os = "macos")]
    std::thread::spawn(|| {
        let mut saved = match SAVED_VOLUME.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        if saved.is_some() {
            return; // already ducked
        }
        let Some(current) = read_output_volume() else {
            return;
        };
        // If the system is already silent, nothing to duck — don't save a zero
        // that would prevent future restores from ever raising it back up.
        if current == 0 {
            return;
        }
        let target = (current as f32 * DUCK_SCALAR).round() as u32;
        set_output_volume(target);
        *saved = Some(current);
    });
}

/// Restore the system volume to whatever it was before `duck()`. Safe to call
/// when nothing is ducked — a no-op in that case. Idempotent, so it can be
/// sprinkled on every dictation teardown path without double-restoring.
pub fn restore() {
    #[cfg(target_os = "macos")]
    std::thread::spawn(|| {
        let original = {
            let mut guard = match SAVED_VOLUME.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            guard.take()
        };
        let Some(original) = original else {
            return;
        };
        set_output_volume(original);
    });
}
