pub(in crate::stt::polish) const RAW_WAV_FAST_PATH_MAX_BYTES: usize = 384 * 1024;
pub(in crate::stt::polish) const ESTIMATED_UPLOAD_BYTES_PER_MS: f64 = 1300.0;
pub(in crate::stt::polish) const FLAC_DECISION_MARGIN_MS: f64 = 20.0;

/// Transcode 16kHz mono 16-bit PCM WAV bytes to FLAC.
///
/// Swift writes a standard RIFF/WAVE file with 16-bit signed little-endian PCM
/// at 16kHz mono. We parse it with `hound`, widen the samples to `i32` (what
/// `flacenc` wants), then run the pure-Rust `flacenc` encoder with its default
/// config. A 30-second dictation shrinks from ~960KB WAV to roughly 300KB FLAC
/// — about 3x — which drops the upload base64 payload from ~1.3MB to ~400KB
/// and cuts a ~400ms upload to ~130ms.
///
/// ### Why FLAC instead of Opus (24kbps → 10x)
///
/// The obvious win here is Opus: at 24kbps voice mode a 30-second dictation
/// would be ~90KB, not ~300KB. Unfortunately every published Rust wrapper in
/// 2026 (`ogg-opus 0.1`, `audiopus 0.2`) pulls `audiopus_sys 0.1.x`
/// transitively, which builds libopus via autoconf/automake. Those tools are
/// NOT part of a vanilla macOS toolchain — a fresh machine would need
/// `brew install autoconf automake libtool` before `cargo check` even
/// compiles, which adds friction for setting up the repo. `audiopus_sys 0.2.x`
/// switched to cmake (already present) but no published `audiopus` release uses
/// it yet. FLAC gives us 3x compression with zero C deps today, and we can
/// revisit Opus once the upstream crates publish a cmake-based release.
///
/// Returns `None` if anything fails (caller falls back to sending the raw
/// WAV). This path is strictly opportunistic — polish must never hard-fail
/// just because an audio codec had a bad day.
pub(in crate::stt::polish) fn wav_to_flac(wav_bytes: &[u8]) -> Option<Vec<u8>> {
    let cursor = std::io::Cursor::new(wav_bytes);
    let mut reader = match hound::WavReader::new(cursor) {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("hound WAV parse failed: {e}");
            return None;
        }
    };

    let spec = reader.spec();
    // We expect exactly what Swift writes: 16kHz mono 16-bit PCM.
    // If any of those assumptions break, bail and let the caller fall back.
    if spec.channels != 1
        || spec.sample_rate != 16_000
        || spec.bits_per_sample != 16
        || spec.sample_format != hound::SampleFormat::Int
    {
        tracing::warn!(
            "Unexpected WAV format (channels={}, rate={}, bits={}, fmt={:?}), skipping FLAC",
            spec.channels,
            spec.sample_rate,
            spec.bits_per_sample,
            spec.sample_format,
        );
        return None;
    }

    // flacenc wants i32 samples in the range of `bits_per_sample`. Our WAV is
    // 16-bit, so i16 → i32 is a direct widening cast (no scaling).
    let samples: Result<Vec<i32>, _> = reader.samples::<i16>().map(|s| s.map(i32::from)).collect();
    let samples = match samples {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!("hound sample decode failed: {e}");
            return None;
        }
    };

    if samples.is_empty() {
        tracing::warn!("WAV had zero samples, skipping FLAC transcode");
        return None;
    }

    use flacenc::component::BitRepr;
    use flacenc::error::Verify;

    let config = match flacenc::config::Encoder::default().into_verified() {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("flacenc config verify failed: {e:?}");
            return None;
        }
    };

    let source = flacenc::source::MemSource::from_samples(
        &samples, 1,      // channels
        16,     // bits per sample
        16_000, // sample rate
    );

    let stream = match flacenc::encode_with_fixed_block_size(&config, source, config.block_size) {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!("flacenc encode failed: {e:?}");
            return None;
        }
    };

    let mut sink = flacenc::bitsink::ByteSink::new();
    if let Err(e) = stream.write(&mut sink) {
        tracing::warn!("flacenc bitstream write failed: {e:?}");
        return None;
    }

    Some(sink.as_slice().to_vec())
}
