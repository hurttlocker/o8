//! Procedural UI sound cues (Symon parity, #1208).
//!
//! Short synthesized tones for voice events — no asset files. All cues are
//! frequency-sweep chirps / double-blips generated as raw 44.1kHz mono PCM,
//! pre-synthesized once at boot and cached on a dedicated audio worker thread
//! that owns its OWN `rodio::OutputStream` (separate from the TTS playback sink,
//! so cues never collide with a read-aloud). The hot path (`play_sound`) is a
//! single non-blocking channel send. Ported from aqua/Symon `lib.rs`.
//!
//! Cues:
//!   Tink      rising chirp   — start listening
//!   Pop       falling chirp  — stop listening
//!   Morse     double blip    — long-form / panel mode
//!   Chime     slow rise      — Ask
//!   Done      short rise     — paste landed
//!   ReadStart gentle rise    — read-aloud start
//!   ReadDone  soft resolve   — read-aloud finish

use std::sync::mpsc;
use std::sync::OnceLock;

/// Sender for the cached-waveform audio worker. `None` until `spawn_worker`
/// has booted — `play_sound` is then a no-op for that tiny startup window.
static AUDIO_TX: OnceLock<mpsc::Sender<&'static str>> = OnceLock::new();

/// Play a named cue (non-blocking — a single channel send). No-op for unknown
/// names or before the worker boots.
pub(crate) fn play_sound(name: &'static str) {
    // The pref store lives in the macOS-gated stt module; cues are part of the
    // voice stack, which stays absent off macOS (#1673) — no-op there.
    #[cfg(target_os = "macos")]
    {
        // Gated by the `sounds_enabled` voice pref (default on).
        if !crate::stt::keys::config_bool("sounds_enabled", true) {
            return;
        }
        if let Some(tx) = AUDIO_TX.get() {
            let _ = tx.send(name);
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = name;
}

/// Generate a frequency-sweeping chirp as raw PCM (44.1kHz mono), with a
/// sine half-window envelope so it fades in and out without clicks.
fn chirp_samples(freq_start: f32, freq_end: f32, duration_ms: u64, volume: f32) -> Vec<f32> {
    let sample_rate = 44100u32;
    let total_samples = (sample_rate as u64 * duration_ms / 1000) as usize;
    (0..total_samples)
        .map(|i| {
            let t = i as f32 / sample_rate as f32;
            let progress = i as f32 / total_samples.max(1) as f32;
            let freq = freq_start + (freq_end - freq_start) * progress;
            let envelope = (progress * std::f32::consts::PI).sin();
            (t * freq * 2.0 * std::f32::consts::PI).sin() * volume * envelope
        })
        .collect()
}

/// Generate a double-blip (two enveloped chirps with a gap) as raw PCM.
fn double_blip_samples(
    freq_start: f32,
    freq_end: f32,
    pip_ms: u64,
    gap_ms: u64,
    volume: f32,
) -> Vec<f32> {
    let sample_rate = 44100u32;
    let pip_samples = (sample_rate as u64 * pip_ms / 1000) as usize;
    let gap_samples = (sample_rate as u64 * gap_ms / 1000) as usize;
    let total = pip_samples * 2 + gap_samples;
    (0..total)
        .map(|i| {
            let t = i as f32 / sample_rate as f32;
            let in_pip = i < pip_samples || i >= pip_samples + gap_samples;
            if !in_pip {
                return 0.0;
            }
            let pip_i = if i < pip_samples {
                i
            } else {
                i - pip_samples - gap_samples
            };
            let progress = pip_i as f32 / pip_samples.max(1) as f32;
            let freq = freq_start + (freq_end - freq_start) * progress;
            let envelope = (progress * std::f32::consts::PI).sin();
            (t * freq * 2.0 * std::f32::consts::PI).sin() * volume * envelope
        })
        .collect()
}

/// Pre-synthesize all cue waveforms + spawn a dedicated audio thread that owns
/// the `rodio::OutputStream` for the life of the app, so `play_sound` is a
/// single non-blocking channel send (no device lookup / synthesis / thread
/// spawn on the press path). Call ONCE from setup. macOS only (rodio device).
#[cfg(target_os = "macos")]
pub fn spawn_worker() {
    let (tx, rx) = mpsc::channel::<&'static str>();
    if AUDIO_TX.set(tx).is_err() {
        return;
    }

    std::thread::spawn(move || {
        use rodio::{OutputStream, Source};

        let Ok((_stream, handle)) = OutputStream::try_default() else {
            log::error!("[sound] no default output device; cues disabled");
            return;
        };

        // Frequencies/durations are verbatim from aqua so the cues sound the same.
        let tink: Vec<f32> = chirp_samples(600.0, 900.0, 80, 0.15);
        let pop: Vec<f32> = chirp_samples(700.0, 400.0, 80, 0.12);
        let morse: Vec<f32> = double_blip_samples(750.0, 850.0, 50, 60, 0.15);
        let chime: Vec<f32> = chirp_samples(440.0, 660.0, 600, 0.08);
        let done: Vec<f32> = chirp_samples(523.0, 659.0, 120, 0.10);
        let read_start: Vec<f32> = chirp_samples(392.0, 523.0, 420, 0.085);
        let read_done: Vec<f32> = chirp_samples(523.0, 392.0, 300, 0.075);

        while let Ok(name) = rx.recv() {
            let pcm: &[f32] = match name {
                "Tink" => &tink,
                "Pop" => &pop,
                "Morse" => &morse,
                "Chime" => &chime,
                "Done" => &done,
                "ReadStart" => &read_start,
                "ReadDone" => &read_done,
                _ => continue,
            };
            let buffer = rodio::buffer::SamplesBuffer::new(1, 44100u32, pcm.to_vec());
            let _ = handle.play_raw(buffer.convert_samples());
        }
    });
}

#[cfg(not(target_os = "macos"))]
pub fn spawn_worker() {}
