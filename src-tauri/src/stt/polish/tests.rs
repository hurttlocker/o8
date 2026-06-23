use super::flac::wav_to_flac;

/// Build a RIFF/WAVE buffer for the given 16-bit mono PCM samples at 16kHz.
/// Bytes-exact to what Swift's AVAudioConverter produces.
fn synth_wav(samples: &[i16]) -> Vec<u8> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: 16_000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut buf: Vec<u8> = Vec::new();
    {
        let cursor = std::io::Cursor::new(&mut buf);
        let mut writer = hound::WavWriter::new(cursor, spec).unwrap();
        for s in samples {
            writer.write_sample(*s).unwrap();
        }
        writer.finalize().unwrap();
    }
    buf
}

/// 30 seconds of a 440Hz sine wave at 16kHz mono, 16-bit.
/// ~960KB of WAV → we expect FLAC to land under ~500KB (ideally ~300KB).
#[test]
fn flac_compresses_synthetic_sine() {
    let duration_secs = 30.0f32;
    let sample_rate = 16_000f32;
    let freq = 440.0f32;
    let n = (duration_secs * sample_rate) as usize;

    let samples: Vec<i16> = (0..n)
        .map(|i| {
            let t = i as f32 / sample_rate;
            let v = (2.0 * std::f32::consts::PI * freq * t).sin();
            // 50% amplitude so we're not clipping.
            (v * (i16::MAX as f32) * 0.5) as i16
        })
        .collect();

    let wav = synth_wav(&samples);
    let wav_kb = wav.len() / 1024;
    assert!(
        (900..1100).contains(&wav_kb),
        "synthetic WAV should be ~960KB, got {wav_kb}KB"
    );

    let flac = wav_to_flac(&wav).expect("flac encode");
    let flac_kb = flac.len() / 1024;
    let ratio = wav.len() as f64 / flac.len() as f64;
    eprintln!("sine: wav={wav_kb}KB flac={flac_kb}KB ratio={ratio:.1}x");

    assert!(flac_kb < 500, "flac should be <500KB, got {flac_kb}KB");
    assert!(ratio > 1.5, "ratio should be >1.5x, got {ratio:.2}");

    // First 4 bytes of a FLAC stream are the "fLaC" magic.
    assert_eq!(&flac[..4], b"fLaC", "output should be a FLAC stream");
}

/// Feed in random-ish noise (less compressible than a pure sine) to stress
/// the encoder on something closer to real speech.
#[test]
fn flac_compresses_pseudo_noise() {
    let sample_rate = 16_000usize;
    let n = sample_rate * 10; // 10 seconds

    // Cheap LCG so the test has no rand dep.
    let mut state: u32 = 0xdead_beef;
    let samples: Vec<i16> = (0..n)
        .map(|_| {
            state = state.wrapping_mul(1_103_515_245).wrapping_add(12_345);
            ((state >> 16) as i16) / 2 // half amplitude to simulate speech
        })
        .collect();

    let wav = synth_wav(&samples);
    let flac = wav_to_flac(&wav).expect("flac encode");
    let ratio = wav.len() as f64 / flac.len() as f64;
    eprintln!(
        "noise: wav={}KB flac={}KB ratio={:.1}x",
        wav.len() / 1024,
        flac.len() / 1024,
        ratio
    );

    // Noise is incompressible in the limit, but FLAC's fixed predictors
    // still save a bit of header overhead vs raw PCM. Just assert we
    // don't BLOW UP the file — if FLAC output is > 2x the WAV, something
    // is very wrong.
    assert!(ratio > 0.9, "noise ratio shouldn't balloon, got {ratio:.2}");
    assert_eq!(&flac[..4], b"fLaC");
}

/// Unexpected WAV format (stereo 44.1kHz) should gracefully return None,
/// NOT panic. This is the fallback-to-raw-WAV path we rely on in polish().
#[test]
fn flac_rejects_non_matching_wav() {
    let spec = hound::WavSpec {
        channels: 2,
        sample_rate: 44_100,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut buf: Vec<u8> = Vec::new();
    {
        let cursor = std::io::Cursor::new(&mut buf);
        let mut writer = hound::WavWriter::new(cursor, spec).unwrap();
        for _ in 0..1000 {
            writer.write_sample(0i16).unwrap();
            writer.write_sample(0i16).unwrap();
        }
        writer.finalize().unwrap();
    }

    assert!(
        wav_to_flac(&buf).is_none(),
        "non-matching WAV should fall back to None"
    );
}

/// Garbage bytes should return None, not panic.
#[test]
fn flac_rejects_garbage() {
    assert!(wav_to_flac(&[0u8; 8]).is_none());
    assert!(wav_to_flac(b"not a wav file at all").is_none());
}
