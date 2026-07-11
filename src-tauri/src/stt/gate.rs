//! Silence gate + hallucination denylist for the dictation finalize path
//! (#1544-adjacent).
//!
//! Two independent nets keep an accidental Fn tap or a moment of ambient noise
//! from pasting a Whisper "no speech" hallucination (classically "Thank you.")
//! at the system caret:
//!
//!   1. **Silence gate** — parse the recorded WAV, compute RMS + duration, and
//!      short-circuit the whole transcribe/polish/paste chain when the audio is
//!      below the noise floor OR shorter than a deliberate press.
//!   2. **Artifact denylist** — after transcription, drop the result when the
//!      WHOLE transcript (normalized) is one of Whisper's canonical silence
//!      artifacts. Whole-transcript only — real speech that merely contains
//!      "you" or "thank you" is never touched.
//!
//! The gate + normalization are pure functions so they're unit-tested directly.

/// RMS floor below which captured audio is treated as silence, in dBFS
/// (full scale = i16::MAX). Ambient room tone typically sits well under this;
/// even quiet speech clears it comfortably.
pub const SILENCE_RMS_DBFS: f32 = -50.0;

/// Minimum dictation length. A hold shorter than this is an accidental tap, not
/// a deliberate utterance — gate it regardless of level.
pub const MIN_DICTATION_MS: u64 = 300;

/// Loudness + length of a decoded PCM buffer.
#[derive(Debug, Clone, Copy)]
pub struct AudioStats {
    pub rms_dbfs: f32,
    pub duration_ms: u64,
}

/// RMS of 16-bit PCM samples in dBFS. Empty or all-zero input returns
/// `NEG_INFINITY` (unambiguously "silence").
pub fn rms_dbfs(samples: &[i16]) -> f32 {
    if samples.is_empty() {
        return f32::NEG_INFINITY;
    }
    let sum_sq: f64 = samples.iter().map(|s| (*s as f64) * (*s as f64)).sum();
    let rms = (sum_sq / samples.len() as f64).sqrt();
    if rms <= 0.0 {
        return f32::NEG_INFINITY;
    }
    (20.0 * (rms / i16::MAX as f64).log10()) as f32
}

/// Duration of a mono buffer of `frames` samples at `sample_rate`, in ms.
pub fn duration_ms(frames: usize, sample_rate: u32) -> u64 {
    if sample_rate == 0 {
        return 0;
    }
    (frames as u64 * 1000) / sample_rate as u64
}

/// Decode 16-bit PCM WAV bytes (what the speech helper writes) and return its
/// loudness + duration. `None` when the buffer isn't the expected 16-bit int
/// PCM — the caller treats "can't analyze" as "don't gate" (fail open to
/// transcription), never as silence.
pub fn analyze_wav(wav_bytes: &[u8]) -> Option<AudioStats> {
    let cursor = std::io::Cursor::new(wav_bytes);
    let mut reader = hound::WavReader::new(cursor).ok()?;
    let spec = reader.spec();
    if spec.bits_per_sample != 16 || spec.sample_format != hound::SampleFormat::Int {
        return None;
    }
    let samples: Vec<i16> = reader.samples::<i16>().filter_map(Result::ok).collect();
    let channels = spec.channels.max(1) as usize;
    let frames = samples.len() / channels;
    Some(AudioStats {
        rms_dbfs: rms_dbfs(&samples),
        duration_ms: duration_ms(frames, spec.sample_rate),
    })
}

/// Whether these stats are below the noise floor or too short to be a
/// deliberate utterance.
pub fn is_silence(stats: &AudioStats) -> bool {
    stats.rms_dbfs < SILENCE_RMS_DBFS || stats.duration_ms < MIN_DICTATION_MS
}

/// Normalize a transcript for artifact matching: lowercase, then strip
/// surrounding whitespace and trailing/leading punctuation. "Thank you." and
/// "  thank you " both normalize to "thank you"; a bare "." normalizes to "".
pub fn normalize_for_denylist(text: &str) -> String {
    text.to_lowercase()
        .trim_matches(|c: char| {
            c.is_whitespace() || matches!(c, '.' | ',' | '!' | '?' | ';' | ':' | '-' | '"' | '\'')
        })
        .to_string()
}

/// Classic Whisper silence / no-speech hallucinations. Matched against the
/// WHOLE normalized transcript only. `""` catches a transcript that was nothing
/// but punctuation (e.g. ".").
const SILENCE_ARTIFACTS: &[&str] = &[
    "",
    "thank you",
    "thanks for watching",
    "you",
    "thank you for watching",
    "bye",
];

/// Whether the WHOLE transcript is a silence artifact and should be dropped.
/// Never substring-matches: "thank you all for coming today" is real speech.
pub fn is_silence_artifact(text: &str) -> bool {
    let normalized = normalize_for_denylist(text);
    SILENCE_ARTIFACTS.contains(&normalized.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a 16kHz mono 16-bit PCM WAV from the given samples.
    fn wav_of(samples: &[i16]) -> Vec<u8> {
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 16_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut cursor = std::io::Cursor::new(Vec::new());
        {
            let mut writer = hound::WavWriter::new(&mut cursor, spec).unwrap();
            for s in samples {
                writer.write_sample(*s).unwrap();
            }
            writer.finalize().unwrap();
        }
        cursor.into_inner()
    }

    #[test]
    fn silent_wav_is_gated() {
        // 1s of pure silence at 16kHz.
        let stats = analyze_wav(&wav_of(&vec![0i16; 16_000])).unwrap();
        assert_eq!(stats.rms_dbfs, f32::NEG_INFINITY);
        assert!(is_silence(&stats));
    }

    #[test]
    fn quiet_noise_below_floor_is_gated() {
        // 1s of very low-level tone (~-60 dBFS), under the -50 floor.
        let amp = 33i16; // 20*log10(33/32767) ≈ -60 dBFS
        let samples: Vec<i16> = (0..16_000)
            .map(|i| if i % 2 == 0 { amp } else { -amp })
            .collect();
        let stats = analyze_wav(&wav_of(&samples)).unwrap();
        assert!(stats.rms_dbfs < SILENCE_RMS_DBFS, "rms was {}", stats.rms_dbfs);
        assert!(is_silence(&stats));
    }

    #[test]
    fn real_speech_level_passes() {
        // 1s of a loud-ish square wave (~-6 dBFS) — well above the floor.
        let amp = 16_000i16;
        let samples: Vec<i16> = (0..16_000)
            .map(|i| if (i / 40) % 2 == 0 { amp } else { -amp })
            .collect();
        let stats = analyze_wav(&wav_of(&samples)).unwrap();
        assert!(stats.rms_dbfs > SILENCE_RMS_DBFS, "rms was {}", stats.rms_dbfs);
        assert_eq!(stats.duration_ms, 1000);
        assert!(!is_silence(&stats));
    }

    #[test]
    fn sub_300ms_hold_is_gated() {
        // A loud but 100ms tap — level clears the floor, duration doesn't.
        let amp = 16_000i16;
        let samples: Vec<i16> = (0..1_600) // 100ms at 16kHz
            .map(|i| if (i / 40) % 2 == 0 { amp } else { -amp })
            .collect();
        let stats = analyze_wav(&wav_of(&samples)).unwrap();
        assert!(stats.rms_dbfs > SILENCE_RMS_DBFS);
        assert_eq!(stats.duration_ms, 100);
        assert!(is_silence(&stats));
    }

    #[test]
    fn denylist_drops_whole_transcript_artifacts() {
        assert!(is_silence_artifact("Thank you."));
        assert!(is_silence_artifact("thank you"));
        assert!(is_silence_artifact("  THANK YOU  "));
        assert!(is_silence_artifact("you"));
        assert!(is_silence_artifact("Bye!"));
        assert!(is_silence_artifact("thanks for watching"));
        assert!(is_silence_artifact("."));
        assert!(is_silence_artifact(""));
    }

    #[test]
    fn denylist_keeps_real_speech() {
        assert!(!is_silence_artifact("thank you all for coming today"));
        assert!(!is_silence_artifact("thank you for the update on the deploy"));
        assert!(!is_silence_artifact("did you see the review"));
        assert!(!is_silence_artifact("bye bye birdie is a musical"));
    }
}
