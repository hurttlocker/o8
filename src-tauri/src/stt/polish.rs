//! Audio-assisted transcript correction via Gemini.
//!
//! The hybrid STT pipeline:
//! 1. Apple Speech provides real-time partials (visual feedback)
//! 2. On release: Gemini reviews Apple's transcript against the actual audio
//! 3. Gemini corrects mishears using audio + app metadata + dictionary
//!
//! This is ONE API call per dictation (same as before), just with more data.
//!
//! De-Symonized: the OpenRouter + Claude-Code-CLI providers and the Symon
//! proxy/license routes are gone. Gemini is the ONLY provider and is called
//! directly at `generativelanguage.googleapis.com` using `get_gemini_key()`
//! (env-first, un-gated, release-safe).

use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use std::time::Duration;

/// Use the full Flash model (supports audio + vision + text).
pub const GEMINI_MODEL: &str = "gemini-3-flash-preview";

/// Timeout — audio upload + inference takes longer than text-only.
/// A 30-second dictation is ~960KB raw WAV, but we transcode to FLAC
/// (pure-Rust `flacenc`) before uploading, which shrinks it by ~3x to
/// roughly 300KB. See `wav_to_flac` for why we picked FLAC over Opus.
/// Timeout stays generous to survive slow networks or an occasional
/// fallback to raw WAV when transcoding fails.
const TIMEOUT_SECS: u64 = 30;

/// Below roughly 12 seconds of 16kHz mono PCM (~384KB WAV), the pure-Rust FLAC
/// transcode often costs more wall-clock time than it saves on upload on the
/// release path. Keep short and medium-short dictations on raw WAV for lower
/// release-to-paste latency, and reserve FLAC for longer clips where the
/// network savings dominate.
const RAW_WAV_FAST_PATH_MAX_BYTES: usize = 384 * 1024;
const ESTIMATED_UPLOAD_BYTES_PER_MS: f64 = 1300.0;
const FLAC_DECISION_MARGIN_MS: f64 = 20.0;
const PROVIDER_MAX_ATTEMPTS: usize = 2;
const PROVIDER_RETRY_DELAY_MS: u64 = 250;
const GEMINI_FLASH_TEXT_IMAGE_INPUT_USD_PER_MILLION: f64 = 0.50;
const GEMINI_FLASH_AUDIO_INPUT_USD_PER_MILLION: f64 = 1.00;
const GEMINI_FLASH_OUTPUT_USD_PER_MILLION: f64 = 3.00;

/// Shared, persistent HTTP client for Gemini calls.
///
/// Building a fresh `reqwest::blocking::Client` on every polish call costs
/// ~100-300ms for the TCP + TLS handshake against Google's API. This client
/// is lazily initialized once and then reused across every dictation, with
/// HTTP/2 keep-alive and a 5-minute idle pool timeout so connections survive
/// between dictations.
static SHARED_CLIENT: OnceLock<reqwest::blocking::Client> = OnceLock::new();

/// Lazily initialize and return the shared HTTP client.
fn shared_client() -> &'static reqwest::blocking::Client {
    SHARED_CLIENT.get_or_init(|| {
        reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(TIMEOUT_SECS))
            .connect_timeout(Duration::from_secs(10))
            .pool_idle_timeout(Duration::from_secs(300))
            .pool_max_idle_per_host(4)
            .http2_adaptive_window(true)
            .build()
            .unwrap_or_else(|e| {
                tracing::warn!(
                    "Failed to build shared reqwest client ({e}), falling back to default"
                );
                reqwest::blocking::Client::new()
            })
    })
}

fn should_retry_status(status: reqwest::StatusCode) -> bool {
    status == reqwest::StatusCode::REQUEST_TIMEOUT
        || status == reqwest::StatusCode::TOO_MANY_REQUESTS
        || status.is_server_error()
}

fn should_retry_error(error: &reqwest::Error) -> bool {
    error.is_timeout() || error.is_connect() || error.is_request()
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PolishProvider {
    #[default]
    Gemini,
}

impl std::fmt::Display for PolishProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Gemini => write!(f, "gemini"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PolishModelConfig {
    pub provider: PolishProvider,
    pub model: String,
}

impl Default for PolishModelConfig {
    fn default() -> Self {
        Self {
            provider: PolishProvider::Gemini,
            model: GEMINI_MODEL.to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PolishRunResult {
    pub text: String,
    pub provider: String,
    pub model: String,
    pub latency_ms: u64,
    pub skipped: bool,
    /// True when polishing was attempted but failed/timed out and we fell back
    /// to the raw transcript — drives the amber "not polished" flash so the
    /// silent fallback is visible.
    pub fell_back: bool,
    pub prompt_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
    pub audio_input_tokens: Option<u64>,
    pub estimated_cost_usd: Option<f64>,
    pub usage_metadata_json: Option<String>,
}

pub fn load_model_config() -> PolishModelConfig {
    PolishModelConfig::default()
}

/// Warm the shared client and TLS handshake to `generativelanguage.googleapis.com`.
///
/// Call this once at app startup on a background thread. It touches the
/// `SHARED_CLIENT` `OnceLock` to trigger lazy init, then fires a cheap HEAD
/// request against the Gemini API origin so the TLS handshake is already
/// cached before the user's first dictation. A 5-second timeout keeps this
/// from ever blocking startup.
///
/// If no Gemini API key is configured, warmup is skipped entirely.
pub fn warmup() {
    if crate::stt::keys::get_gemini_key().is_some() {
        // Touch SHARED_CLIENT to trigger lazy init up front so the first real
        // polish call doesn't pay that one-time cost either.
        let client = shared_client();

        match client
            .head("https://generativelanguage.googleapis.com")
            .timeout(Duration::from_secs(5))
            .send()
        {
            Ok(_) => tracing::info!("gemini warmup ok"),
            Err(e) => tracing::info!("gemini warmup failed: {e}"),
        }
    } else {
        tracing::info!("gemini warmup skipped: no API key");
    }
}

#[derive(Deserialize)]
struct Response {
    candidates: Option<Vec<Candidate>>,
    #[serde(rename = "usageMetadata")]
    usage_metadata: Option<GeminiUsageMetadata>,
}

#[derive(Deserialize)]
struct Candidate {
    content: CandidateContent,
    /// Gemini's reason for stopping. Useful to log when we see silently-
    /// truncated polish output — STOP means natural end, MAX_TOKENS or
    /// LENGTH means our output cap was hit, SAFETY or other values mean
    /// Gemini bailed. Optional because not every provider returns it.
    #[serde(rename = "finishReason")]
    finish_reason: Option<String>,
}

#[derive(Deserialize)]
struct CandidateContent {
    parts: Vec<ResponsePart>,
}

#[derive(Deserialize)]
struct ResponsePart {
    text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct GeminiUsageMetadata {
    #[serde(rename = "promptTokenCount")]
    prompt_token_count: Option<u64>,
    #[serde(rename = "candidatesTokenCount")]
    candidates_token_count: Option<u64>,
    #[serde(rename = "totalTokenCount")]
    total_token_count: Option<u64>,
    #[serde(rename = "cachedContentTokenCount")]
    cached_content_token_count: Option<u64>,
    #[serde(rename = "thoughtsTokenCount")]
    #[allow(dead_code)]
    thoughts_token_count: Option<u64>,
}

#[derive(Default)]
struct ModelRun {
    text: String,
    prompt_tokens: Option<u64>,
    output_tokens: Option<u64>,
    total_tokens: Option<u64>,
    audio_input_tokens: Option<u64>,
    estimated_cost_usd: Option<f64>,
    usage_metadata_json: Option<String>,
}

/// Check if Gemini polishing is available (API key is set).
pub fn is_available() -> bool {
    is_config_available(&load_model_config())
}

pub fn is_config_available(config: &PolishModelConfig) -> bool {
    match config.provider {
        PolishProvider::Gemini => crate::stt::keys::get_gemini_key().is_some(),
    }
}

pub fn supports_audio_context(config: &PolishModelConfig) -> bool {
    matches!(config.provider, PolishProvider::Gemini)
}

pub fn should_skip_polish(ctx: &PolishContext) -> bool {
    let word_count = ctx.transcript.split_whitespace().count();
    if !(3..=8).contains(&word_count) {
        return false;
    }

    if !ctx.dictionary.is_empty() || !ctx.instructions.trim().is_empty() {
        return false;
    }

    if ctx
        .frontmost_app
        .as_deref()
        .map(app_category)
        .is_some_and(|category| matches!(category, AppCategory::CodeEditor))
    {
        return false;
    }

    let text = ctx.transcript.trim();
    if text.len() > 72 || text.contains('\n') {
        return false;
    }

    let first = match text.chars().next() {
        Some(ch) => ch,
        None => return false,
    };
    if !first.is_uppercase() {
        return false;
    }

    let last = match text.chars().last() {
        Some(ch) => ch,
        None => return false,
    };
    if !matches!(last, '.' | '!' | '?') {
        return false;
    }

    let lower_words = text
        .split_whitespace()
        .map(|word| {
            word.trim_matches(|ch: char| !ch.is_alphanumeric())
                .to_lowercase()
        })
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>();

    for pair in lower_words.windows(2) {
        if pair[0] == pair[1] {
            return false;
        }
    }

    true
}

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
fn wav_to_flac(wav_bytes: &[u8]) -> Option<Vec<u8>> {
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

/// Everything we know about this dictation — sent to Gemini in one call.
pub struct PolishContext<'a> {
    /// Apple Speech's raw transcript (what we're correcting).
    pub transcript: &'a str,
    /// The recorded audio WAV file (so Gemini can hear what was actually said).
    pub audio_wav: Option<&'a [u8]>,
    /// Bundle ID of the frontmost app (e.g. "com.apple.mail", "com.tinyspeck.slackmacgap").
    pub frontmost_app: Option<String>,
    /// Title of the focused window (gathered via AX). Cheap, usually present.
    pub window_title: Option<String>,
    /// Whatever the user has highlighted in the focused element. Gold signal
    /// when present — the user explicitly told us what matters.
    pub selected_text: Option<String>,
    /// Compact text dump of the focused window's AX tree (depth-capped,
    /// ~3 KB max). Empty for canvas/Electron apps.
    pub ax_excerpt: Option<String>,
    /// Custom dictionary words from settings.
    pub dictionary: Vec<String>,
    /// Custom instructions from settings (e.g. "always capitalize iOS").
    pub instructions: String,
    /// Phrase replacements applied after polish for deterministic expansion.
    pub replacements: Vec<crate::stt::commands::ReplacementRule>,
}

/// Polish a transcript using all available context.
///
/// Sends Apple's transcript + audio + metadata + dictionary + instructions to
/// Gemini. Returns the corrected text. Falls back to the original transcript
/// if anything fails.
pub fn polish(ctx: &PolishContext) -> String {
    polish_with_stats(ctx).text
}

pub fn polish_with_stats(ctx: &PolishContext) -> PolishRunResult {
    polish_with_config_and_stats(ctx, load_model_config())
}

pub fn polish_with_config_and_stats(
    ctx: &PolishContext,
    config: PolishModelConfig,
) -> PolishRunResult {
    let start = std::time::Instant::now();

    if !is_config_available(&config) {
        return PolishRunResult {
            text: crate::stt::commands::apply_replacements(ctx.transcript, &ctx.replacements),
            provider: config.provider.to_string(),
            model: config.model,
            latency_ms: start.elapsed().as_millis() as u64,
            skipped: true,
            fell_back: false,
            prompt_tokens: None,
            output_tokens: None,
            total_tokens: None,
            audio_input_tokens: None,
            estimated_cost_usd: None,
            usage_metadata_json: None,
        };
    }

    // Don't bother polishing very short text
    if ctx.transcript.split_whitespace().count() < 3 {
        return PolishRunResult {
            text: crate::stt::commands::apply_replacements(ctx.transcript, &ctx.replacements),
            provider: config.provider.to_string(),
            model: config.model,
            latency_ms: 0,
            skipped: false,
            fell_back: false,
            prompt_tokens: None,
            output_tokens: None,
            total_tokens: None,
            audio_input_tokens: None,
            estimated_cost_usd: None,
            usage_metadata_json: None,
        };
    }

    let model_run = match config.provider {
        PolishProvider::Gemini => polish_with_gemini(ctx, &config),
    };

    // Every failure path in the provider returns the raw transcript verbatim;
    // a successful polish of ≥3-word text effectively never matches it. So an
    // unchanged result means polishing fell back.
    let fell_back = model_run.text == ctx.transcript;

    PolishRunResult {
        text: crate::stt::commands::apply_replacements(&model_run.text, &ctx.replacements),
        provider: config.provider.to_string(),
        model: config.model,
        latency_ms: start.elapsed().as_millis() as u64,
        skipped: false,
        fell_back,
        prompt_tokens: model_run.prompt_tokens,
        output_tokens: model_run.output_tokens,
        total_tokens: model_run.total_tokens,
        audio_input_tokens: model_run.audio_input_tokens,
        estimated_cost_usd: model_run.estimated_cost_usd,
        usage_metadata_json: model_run.usage_metadata_json,
    }
}

fn polish_with_gemini(ctx: &PolishContext, config: &PolishModelConfig) -> ModelRun {
    // Direct Gemini API — no proxy, no license token. Key is env-first.
    let api_key = match crate::stt::keys::get_gemini_key() {
        Some(key) => key,
        None => {
            return ModelRun {
                text: ctx.transcript.to_string(),
                ..ModelRun::default()
            };
        }
    };
    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
        config.model, api_key
    );

    let audio_input_tokens = ctx.audio_wav.and_then(estimate_audio_input_tokens);
    let mut audio_attached = false;

    // Build the prompt with all available context
    let multimodal_prompt = build_prompt(ctx, true);

    // Build the multimodal parts array
    let mut multimodal_parts = vec![serde_json::json!({ "text": multimodal_prompt })];

    // Add audio if available (Gemini can listen to the actual recording).
    //
    // Swift writes 16kHz mono 16-bit PCM WAV. Raw WAV at that rate is
    // ~32KB/sec, so a 30-second dictation is ~960KB — base64-encoded that's
    // ~1.3MB and ~400ms of upload latency. We transcode to FLAC here via the
    // pure-Rust `flacenc` crate, which shrinks a 30-second dictation by ~3x
    // (to ~300KB) with zero C dependencies. See `wav_to_flac` for the rant
    // about why this isn't Opus. If transcoding fails for any reason we fall
    // back to the original WAV bytes so polish never hard-fails on an audio
    // codec issue.
    if let Some(audio) = ctx.audio_wav {
        use base64::Engine;
        let wav_kb = audio.len() / 1024;

        let (payload_mime, payload_bytes): (&str, std::borrow::Cow<'_, [u8]>) = if audio.len()
            <= RAW_WAV_FAST_PATH_MAX_BYTES
        {
            tracing::info!(
                "Gemini polish: short audio fast path, sending raw WAV ({}KB)",
                wav_kb
            );
            ("audio/wav", std::borrow::Cow::Borrowed(audio))
        } else {
            let transcode_start = std::time::Instant::now();
            match wav_to_flac(audio) {
                Some(flac) => {
                    let transcode_ms = transcode_start.elapsed().as_millis() as f64;
                    let flac_kb = flac.len() / 1024;
                    let ratio = if flac.is_empty() {
                        0.0
                    } else {
                        audio.len() as f64 / flac.len() as f64
                    };
                    let bytes_saved = audio.len().saturating_sub(flac.len());
                    let estimated_upload_savings_ms =
                        bytes_saved as f64 / ESTIMATED_UPLOAD_BYTES_PER_MS;

                    if estimated_upload_savings_ms <= transcode_ms + FLAC_DECISION_MARGIN_MS {
                        tracing::info!(
                                "Adaptive audio choice: raw WAV won (saved={}KB, est_upload_savings={}ms, transcode={}ms)",
                                bytes_saved / 1024,
                                estimated_upload_savings_ms.round(),
                                transcode_ms.round()
                            );
                        ("audio/wav", std::borrow::Cow::Borrowed(audio))
                    } else {
                        tracing::info!(
                            "FLAC transcode: {}KB WAV → {}KB FLAC ({:.1}x) in {}ms, est upload savings {}ms",
                            wav_kb,
                            flac_kb,
                            ratio,
                            transcode_ms.round(),
                            estimated_upload_savings_ms.round()
                        );
                        ("audio/flac", std::borrow::Cow::Owned(flac))
                    }
                }
                None => {
                    tracing::warn!(
                        "FLAC transcode failed after {}ms, falling back to raw WAV ({}KB)",
                        transcode_start.elapsed().as_millis(),
                        wav_kb
                    );
                    ("audio/wav", std::borrow::Cow::Borrowed(audio))
                }
            }
        };

        let payload_kb = payload_bytes.len() / 1024;
        tracing::info!("Gemini polish: sending {payload_kb}KB of audio ({payload_mime})");

        // Skip audio if > 10MB to avoid timeout (very long dictations).
        if payload_bytes.len() < 10 * 1024 * 1024 {
            let b64_audio =
                base64::engine::general_purpose::STANDARD.encode(payload_bytes.as_ref());
            audio_attached = true;
            multimodal_parts.push(serde_json::json!({
                "inline_data": { "mime_type": payload_mime, "data": b64_audio }
            }));
        } else {
            tracing::warn!("Audio too large ({payload_kb}KB), skipping audio attachment");
        }
    }

    // maxOutputTokens is raised to 16384 because Gemini 3 Flash uses
    // internal "thinking" tokens by default, and those count against the
    // output budget. A 2-minute dictation of ~700 words easily needs
    // 3000+ output tokens once you add reasoning — 2048 was causing the
    // polished output to be silently truncated mid-sentence on long holds.
    //
    // thinkingConfig.thinkingBudget = 0 disables thinking entirely. Polish
    // is a simple fix-up task — it doesn't need multi-step reasoning, and
    // disabling thinking is both faster AND removes the truncation risk.
    let build_body = |parts: Vec<serde_json::Value>| {
        // Direct Gemini API body shape: { contents, generationConfig }
        serde_json::json!({
            "contents": [{ "parts": parts }],
            "generationConfig": {
                "temperature": 0.1,
                "maxOutputTokens": 16384,
                "thinkingConfig": {
                    "thinkingBudget": 0
                }
            }
        })
    };

    let multimodal_body = build_body(multimodal_parts);
    let text_only_body = build_body(vec![serde_json::json!({
        "text": build_prompt(ctx, false)
    })]);

    let client = shared_client();

    let payload_size = serde_json::to_string(&multimodal_body)
        .map(|s| s.len())
        .unwrap_or(0);
    tracing::info!(
        "Gemini polish: sending {:.1}KB payload",
        payload_size as f64 / 1024.0
    );

    let run_request = |body: &serde_json::Value, label: &str| -> Result<Response, String> {
        for attempt in 1..=PROVIDER_MAX_ATTEMPTS {
            let req = client.post(&url).json(body);
            match req.send() {
                Ok(response) if response.status().is_success() => {
                    return response
                        .json::<Response>()
                        .map_err(|e| format!("{label} parse error: {e}"));
                }
                Ok(response) => {
                    let status = response.status();
                    let body_text = response.text().unwrap_or_default();
                    let body_snippet = body_text[..body_text.len().min(200)].to_string();
                    if attempt < PROVIDER_MAX_ATTEMPTS && should_retry_status(status) {
                        tracing::warn!(
                            "{label} transient API error on attempt {attempt}/{PROVIDER_MAX_ATTEMPTS} ({status}): {body_snippet}"
                        );
                        std::thread::sleep(Duration::from_millis(PROVIDER_RETRY_DELAY_MS));
                        continue;
                    }
                    return Err(format!("{label} API error ({status}): {body_snippet}"));
                }
                Err(error) => {
                    if attempt < PROVIDER_MAX_ATTEMPTS && should_retry_error(&error) {
                        tracing::warn!(
                            "{label} request failed on attempt {attempt}/{PROVIDER_MAX_ATTEMPTS}: {error}"
                        );
                        std::thread::sleep(Duration::from_millis(PROVIDER_RETRY_DELAY_MS));
                        continue;
                    }
                    return Err(format!("{label} request failed: {error}"));
                }
            }
        }

        Err(format!("{label} request failed without response"))
    };

    let response = match run_request(&multimodal_body, "Gemini polish") {
        Ok(response) => Some((response, false)),
        Err(error) if audio_attached => {
            tracing::warn!(
                "{error}; degrading to text-only polish (audio_attached={audio_attached})"
            );
            match run_request(&text_only_body, "Gemini text-only fallback") {
                Ok(response) => Some((response, true)),
                Err(fallback_error) => {
                    tracing::warn!("{fallback_error}");
                    None
                }
            }
        }
        Err(error) => {
            tracing::warn!("{error}");
            None
        }
    };

    match response {
        Some((resp, text_only_fallback)) => {
            let polished = resp
                .candidates
                .as_ref()
                .and_then(|c| c.first())
                .and_then(|c| c.content.parts.first())
                .map(|p| p.text.trim().to_string())
                .unwrap_or_default();

            // Flag suspicious truncation: Gemini stopped for a reason other
            // than natural "STOP", or the output is dramatically shorter than
            // the input (suggesting it summarized/cut). Always log finish
            // reason so we can see how often this happens in the wild.
            let finish_reason = resp
                .candidates
                .as_ref()
                .and_then(|c| c.first())
                .and_then(|c| c.finish_reason.as_deref())
                .unwrap_or("MISSING");
            let input_len = ctx.transcript.len();
            let output_len = polished.len();
            let looks_truncated =
                finish_reason != "STOP" || (input_len > 200 && output_len < input_len / 2);
            if looks_truncated {
                tracing::warn!(
                    "Gemini polish looks truncated: finish_reason={} input_len={} output_len={} — keeping Apple's transcript instead",
                    finish_reason,
                    input_len,
                    output_len,
                );
            } else {
                tracing::debug!(
                    "Gemini polish finish_reason={} input_len={} output_len={}",
                    finish_reason,
                    input_len,
                    output_len,
                );
            }

            if polished.is_empty() || looks_truncated {
                tracing::debug!("Gemini returned empty, keeping original");
                ModelRun {
                    text: ctx.transcript.to_string(),
                    prompt_tokens: resp
                        .usage_metadata
                        .as_ref()
                        .and_then(|usage| usage.prompt_token_count),
                    output_tokens: resp
                        .usage_metadata
                        .as_ref()
                        .and_then(|usage| usage.candidates_token_count),
                    total_tokens: resp
                        .usage_metadata
                        .as_ref()
                        .and_then(|usage| usage.total_token_count),
                    audio_input_tokens: (!text_only_fallback)
                        .then_some(audio_input_tokens)
                        .flatten(),
                    estimated_cost_usd: resp.usage_metadata.as_ref().and_then(|usage| {
                        estimate_gemini_cost_usd(
                            config,
                            usage,
                            (!text_only_fallback)
                                .then_some(audio_input_tokens)
                                .flatten(),
                        )
                    }),
                    usage_metadata_json: resp
                        .usage_metadata
                        .as_ref()
                        .and_then(|usage| serde_json::to_string(usage).ok()),
                }
            } else {
                tracing::info!("Gemini polish: {} → {}", ctx.transcript, polished);
                if text_only_fallback {
                    tracing::info!("Gemini polish succeeded via text-only degraded path");
                }
                ModelRun {
                    text: polished,
                    prompt_tokens: resp
                        .usage_metadata
                        .as_ref()
                        .and_then(|usage| usage.prompt_token_count),
                    output_tokens: resp
                        .usage_metadata
                        .as_ref()
                        .and_then(|usage| usage.candidates_token_count),
                    total_tokens: resp
                        .usage_metadata
                        .as_ref()
                        .and_then(|usage| usage.total_token_count),
                    audio_input_tokens: (!text_only_fallback)
                        .then_some(audio_input_tokens)
                        .flatten(),
                    estimated_cost_usd: resp.usage_metadata.as_ref().and_then(|usage| {
                        estimate_gemini_cost_usd(
                            config,
                            usage,
                            (!text_only_fallback)
                                .then_some(audio_input_tokens)
                                .flatten(),
                        )
                    }),
                    usage_metadata_json: resp
                        .usage_metadata
                        .as_ref()
                        .and_then(|usage| serde_json::to_string(usage).ok()),
                }
            }
        }
        None => ModelRun {
            text: ctx.transcript.to_string(),
            ..ModelRun::default()
        },
    }
}

fn estimate_audio_input_tokens(audio_wav: &[u8]) -> Option<u64> {
    // Swift writes 16kHz mono 16-bit PCM WAV with a 44-byte header. Gemini
    // counts audio at 32 tokens/sec, and this PCM payload is 32,000 bytes/sec,
    // so the effective cost works out to roughly 1 token per 1000 bytes.
    if audio_wav.len() <= 44 {
        return Some(0);
    }
    Some((((audio_wav.len() - 44) as f64) / 1000.0).round() as u64)
}

fn estimate_gemini_cost_usd(
    config: &PolishModelConfig,
    usage: &GeminiUsageMetadata,
    audio_input_tokens: Option<u64>,
) -> Option<f64> {
    if config.model != GEMINI_MODEL {
        return None;
    }

    let prompt_tokens = usage.prompt_token_count?;
    let output_tokens = usage.candidates_token_count.unwrap_or(0);
    let cached_tokens = usage.cached_content_token_count.unwrap_or(0);
    let audio_tokens = audio_input_tokens.unwrap_or(0);
    let text_image_tokens =
        prompt_tokens.saturating_sub(audio_tokens.saturating_add(cached_tokens));

    Some(
        (text_image_tokens as f64 * GEMINI_FLASH_TEXT_IMAGE_INPUT_USD_PER_MILLION / 1_000_000.0)
            + (audio_tokens as f64 * GEMINI_FLASH_AUDIO_INPUT_USD_PER_MILLION / 1_000_000.0)
            + (output_tokens as f64 * GEMINI_FLASH_OUTPUT_USD_PER_MILLION / 1_000_000.0),
    )
}

/// Build the text prompt with all available context.
fn build_prompt(ctx: &PolishContext, can_use_audio: bool) -> String {
    let mut prompt = String::new();

    // Core instruction
    if can_use_audio && ctx.audio_wav.is_some() {
        prompt.push_str(
            "You are a speech-to-text correction assistant with a gift for punctuation. \
             Apple's speech recognizer produced the transcript below, but it may contain errors. \
             You also have the ORIGINAL AUDIO recording — listen to it carefully to hear what was actually said.\n\n",
        );
    } else {
        prompt.push_str(
            "You are a speech-to-text correction assistant with a gift for punctuation. \
             Apple's speech recognizer produced the transcript below, but it may contain errors. \
             You do NOT have the original audio for this pass, so infer corrections from transcript context, app context, dictionary hints, and user instructions.\n\n",
        );
    }

    prompt.push_str("CORRECTION RULES:\n");
    if can_use_audio && ctx.audio_wav.is_some() {
        prompt.push_str("- Compare Apple's transcript against what you hear in the audio\n");
    } else {
        prompt.push_str(
            "- Correct obvious dictation errors, homophones, and garbled words from context\n",
        );
    }
    prompt.push_str("- Fix any words Apple misheard (mishears, homophones, garbled words)\n");
    prompt.push_str("- PRESERVE the speaker's exact style, tone, slang, and casual language\n");
    prompt.push_str("- Do NOT formalize casual speech — if they said 'gonna' keep 'gonna'\n");
    prompt.push_str("- Do NOT add or remove words that were actually spoken\n");
    prompt.push_str("- Capitalize proper nouns, names, brands, app names\n\n");

    // Adaptive punctuation — the core upgrade
    prompt.push_str("ADAPTIVE PUNCTUATION — this is critical. Do NOT just add basic periods and commas. \
                     Read between the lines. Listen to HOW the person speaks and infer the punctuation \
                     that makes their text read the way they intended:\n\n");

    prompt.push_str("Prosodic cues (from audio):\n");
    prompt.push_str("- A dramatic pause mid-sentence → em dash (—) for an aside or interruption\n");
    prompt.push_str("- Trailing off, slowing down at the end → ellipsis (…)\n");
    prompt.push_str(
        "- Rising intonation → question mark, even if the words aren't a grammatical question\n",
    );
    prompt.push_str("- Emphasis or air-quote tone on a word/phrase → wrap in quotation marks\n");
    prompt.push_str(
        "- A quick aside spoken faster or softer → parentheses or em dashes around it\n\n",
    );

    prompt.push_str("Semantic cues (from meaning):\n");
    prompt.push_str(
        "- Reporting what someone said or might say → quotation marks around their words\n",
    );
    prompt.push_str("- Referencing a title, term, or label → quotation marks (\"the feature called Spotlight\")\n");
    prompt.push_str(
        "- Using a word ironically or with skepticism → quotation marks (their \"solution\")\n",
    );
    prompt.push_str("- Two closely related independent thoughts → semicolon\n");
    prompt.push_str("- Introducing a list, explanation, or reveal → colon\n");
    prompt.push_str(
        "- A thought that breaks away then resumes → em dashes as parenthetical pair\n\n",
    );

    prompt.push_str("Typography:\n");
    prompt.push_str(
        "- Use curly/smart quotes (\u{201c} \u{201d} \u{2018} \u{2019}), not straight quotes\n",
    );
    prompt.push_str("- Use em dash (\u{2014}), not hyphens or double hyphens\n");
    prompt.push_str("- Use proper ellipsis character (\u{2026}), not three periods\n");
    prompt.push_str("- Use en dash (\u{2013}) for ranges (e.g. 3\u{2013}5 minutes)\n\n");

    prompt.push_str("Be opinionated. If the sentence reads better with an em dash than a comma, use the em dash. \
                     If quotes would add clarity or voice, add them. The goal is text that reads like the person \
                     sounds — their rhythm, their pauses, their emphasis — not just grammatically correct transcription.\n\n");

    // Unified app/text context — reply awareness, tone, spelling, hallucination guard
    let has_text_context =
        ctx.window_title.is_some() || ctx.selected_text.is_some() || ctx.ax_excerpt.is_some();
    if ctx.frontmost_app.is_some() || has_text_context {
        prompt.push_str("APP & TEXT CONTEXT:\n");

        let app_name = ctx
            .frontmost_app
            .as_deref()
            .map(app_display_name)
            .unwrap_or("an application");
        let category = ctx
            .frontmost_app
            .as_deref()
            .map(app_category)
            .unwrap_or(AppCategory::Other);

        prompt.push_str(&format!("The user is typing into {}.", app_name));

        if let Some(title) = ctx.window_title.as_deref() {
            let title = title.trim();
            if !title.is_empty() && title != app_name {
                prompt.push_str(&format!(" Window: \"{}\".", title));
            }
        }

        prompt.push('\n');

        // Text context — the meat of the "magical" layer. Put selected text
        // first because it's the strongest signal (user explicitly highlighted
        // it), then the broader on-screen excerpt. The rules below are
        // deliberately strict: screen text is a DISAMBIGUATION HINT, never a
        // license to replace words the user clearly pronounced. Prior version
        // over-rotated and swapped "QQQ" (a Nasdaq ETF the user said) with
        // "UGC" (the window title) because the AX excerpt contained UGC.
        let has_text_signal = ctx
            .selected_text
            .as_deref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
            || ctx
                .ax_excerpt
                .as_deref()
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false);
        if has_text_signal {
            prompt.push_str("\nHOW TO USE THE SCREEN TEXT BELOW:\n");
            prompt.push_str("- Use it to spell proper nouns, product names, usernames, and technical terms correctly\n");
            prompt.push_str("- Use it to resolve pronouns (\"he\", \"it\", \"that\") when a referent is obvious on screen\n");
            prompt
                .push_str("- Use it to match the tone of a conversation the user is replying to\n");
            prompt.push_str("- DO NOT replace a word the user pronounced clearly. Trust the audio and Apple's transcript first.\n");
            prompt.push_str("- DO NOT assume every acronym on screen is what the user said. Common finance/tech acronyms (QQQ, SPY, API, USD, ETF) are probably real words the user spoke.\n");
            prompt.push_str("- If you aren't sure, leave the user's word alone.\n");
        }
        if let Some(sel) = ctx.selected_text.as_deref() {
            let sel = sel.trim();
            if !sel.is_empty() {
                prompt.push_str("\nHIGHLIGHTED TEXT (the user selected this — likely the referent of pronouns like \"this\", \"it\", \"that\"):\n");
                prompt.push_str(sel);
                prompt.push('\n');
            }
        }
        if let Some(excerpt) = ctx.ax_excerpt.as_deref() {
            let excerpt = excerpt.trim();
            if !excerpt.is_empty() {
                prompt.push_str("\nVISIBLE TEXT ON SCREEN (focused window contents, for spelling hints only):\n");
                prompt.push_str(excerpt);
                prompt.push('\n');
            }
        }

        match category {
            AppCategory::Messaging => {
                prompt.push_str(
                    "\
                    This is a messaging app. The user is likely replying to a conversation \
                    visible on screen. Use the visible messages to:\n\
                    - Reference names, dates, times, and topics from the visible conversation\n\
                    - Shape the dictation as a natural reply if it sounds like one\n\
                    - Match the conversational tone already established on screen\n\
                    - Keep it casual — messages don\u{2019}t need perfect grammar\n\
                    - Short sentences are better than long ones\n",
                );
            }
            AppCategory::Email => {
                prompt.push_str(
                    "\
                    This is an email app. The user may be composing a reply to the email \
                    visible on screen. Use the visible email to:\n\
                    - Reference names, dates, subjects from the original email\n\
                    - Shape the dictation as a professional reply if it sounds like one\n\
                    - Use complete sentences and proper punctuation\n\
                    - Match the formality level of the original email\n",
                );
            }
            AppCategory::CodeEditor => {
                prompt.push_str(
                    "\
                    This is a code editor. The user may be writing code comments, commit \
                    messages, PR descriptions, or documentation. Use the visible code to:\n\
                    - Spell function names, variables, classes exactly as they appear on screen\n\
                    - Preserve camelCase, snake_case, and technical terms precisely\n\
                    - Keep it concise \u{2014} developers hate verbosity\n\
                    - If the dictation references a visible error or warning, use the exact text\n",
                );
            }
            AppCategory::Writing => {
                prompt.push_str(
                    "\
                    This is a writing or notes app. The user may be continuing a document \
                    visible on screen. Use the visible content to:\n\
                    - Maintain consistent style, terminology, and tone with existing text\n\
                    - Apply your best editorial judgment on punctuation and structure\n\
                    - This is where em dashes, semicolons, and thoughtful prose matter most\n",
                );
            }
            AppCategory::Social => {
                prompt.push_str(
                    "\
                    This is social media. Keep it punchy, casual, and natural. \
                    No formal punctuation unless it adds voice. Fragments are fine.\n",
                );
            }
            AppCategory::Other => {}
        }

        // Hallucination guard — critical
        prompt.push_str("\nCRITICAL: The user\u{2019}s spoken words ALWAYS take precedence over visible app text. \
                         If the app text says \u{201c}Thursday at 3\u{201d} but the user says \u{201c}Thursday at 2,\u{201d} \
                         keep 2. The app text is context for understanding intent, NOT ground truth. \
                         Never \u{201c}correct\u{201d} the user\u{2019}s words to match what\u{2019}s on screen.\n\n");
    }

    // Add dictionary words
    if !ctx.dictionary.is_empty() {
        prompt.push_str(&format!(
            "CUSTOM DICTIONARY (spell exactly as shown): {}\n\n",
            ctx.dictionary.join(", ")
        ));
    }

    // Add user instructions
    if !ctx.instructions.is_empty() {
        prompt.push_str(&format!("USER INSTRUCTIONS: {}\n\n", ctx.instructions));
    }

    if !ctx.replacements.is_empty() {
        prompt.push_str("PHRASE REPLACEMENTS (deterministic post-pass rules):\n");
        for rule in &ctx.replacements {
            prompt.push_str(&format!(
                "- \"{}\" → \"{}\"\n",
                rule.trigger, rule.replacement
            ));
        }
        prompt.push('\n');
    }

    // Gemini was observed silently truncating long (~1000 char) dictations
    // after the first clean sentence and returning just that. Explicitly
    // demand full coverage so it doesn't "help" by summarizing or stopping
    // at the first natural pause.
    prompt.push_str("OUTPUT COVERAGE (CRITICAL):\n");
    prompt.push_str("- Polish the ENTIRE transcript from start to finish.\n");
    prompt.push_str(
        "- Every word Apple produced must be represented in your output (corrected if needed).\n",
    );
    prompt.push_str("- Do NOT stop early at the first clean sentence. Do NOT summarize the later parts. Do NOT drop tail words.\n");
    prompt.push_str("- If a word or phrase is ambiguous or garbled, keep it verbatim — preserving a rough word beats omitting it.\n");
    prompt.push_str("- The corrected output should be AT LEAST as long as the input, usually within 10% of the same character count.\n");
    prompt.push_str("- Return ONLY the corrected text, no commentary.\n\n");

    prompt.push_str(&format!("APPLE'S TRANSCRIPT:\n{}\n\n", ctx.transcript));

    if ctx.audio_wav.is_some() {
        prompt.push_str("Listen to the audio above. Correct any errors and apply adaptive punctuation based on how the person speaks.\n");
    } else {
        prompt.push_str("Correct any errors and apply adaptive punctuation based on the meaning and rhythm of the text.\n");
    }

    prompt
}

/// App categories for context-aware polish.
#[derive(Debug, Clone, Copy, PartialEq)]
enum AppCategory {
    Messaging,
    Email,
    CodeEditor,
    Writing,
    Social,
    Other,
}

pub fn app_category_for_bundle(bundle_id: &str) -> &'static str {
    match app_category(bundle_id) {
        AppCategory::Messaging => "messaging",
        AppCategory::Email => "email",
        AppCategory::CodeEditor => "code",
        AppCategory::Writing => "writing",
        AppCategory::Social => "social",
        AppCategory::Other => "other",
    }
}

/// Map a bundle ID to a human-readable app name for the prompt.
fn app_display_name(bundle_id: &str) -> &str {
    match bundle_id {
        s if s.contains("slack") => "Slack",
        s if s.contains("discord") => "Discord",
        s if s.contains("MobileSMS") || s.contains("Messages") => "Messages",
        s if s.contains("telegram") => "Telegram",
        s if s.contains("whatsapp") => "WhatsApp",
        s if s.contains("mail") || s.contains("Mail") => "Mail",
        s if s.contains("outlook") || s.contains("Outlook") => "Outlook",
        s if s.contains("gmail") => "Gmail",
        s if s.contains("VSCode") || s.contains("vscode") || s.contains("Code") => "VS Code",
        s if s.contains("xcode") || s.contains("Xcode") => "Xcode",
        s if s.contains("cursor") || s.contains("Cursor") => "Cursor",
        s if s.contains("Terminal") || s.contains("iTerm") || s.contains("Warp") => "Terminal",
        s if s.contains("jetbrains") || s.contains("intellij") => "JetBrains IDE",
        s if s.contains("notion") || s.contains("Notion") => "Notion",
        s if s.contains("bear") => "Bear",
        s if s.contains("ulysses") => "Ulysses",
        s if s.contains("obsidian") => "Obsidian",
        s if s.contains("Pages") => "Pages",
        s if s.contains("TextEdit") => "TextEdit",
        s if s.contains("Notes") => "Notes",
        s if s.contains("docs.google") => "Google Docs",
        s if s.contains("twitter") || s.contains("Twitter") => "X/Twitter",
        s if s.contains("reddit") => "Reddit",
        s if s.contains("Safari")
            || s.contains("Chrome")
            || s.contains("Firefox")
            || s.contains("Arc") =>
        {
            "a web browser"
        }
        _ => "an application",
    }
}

/// Classify a bundle ID into an app category.
fn app_category(bundle_id: &str) -> AppCategory {
    let id = bundle_id.to_lowercase();

    if id.contains("slack")
        || id.contains("discord")
        || id.contains("mobilesms")
        || id.contains("messages")
        || id.contains("telegram")
        || id.contains("whatsapp")
    {
        return AppCategory::Messaging;
    }
    if id.contains("twitter") || id.contains("reddit") {
        return AppCategory::Social;
    }
    if id.contains("mail") || id.contains("outlook") || id.contains("gmail") {
        return AppCategory::Email;
    }
    if id.contains("vscode")
        || id.contains("code")
        || id.contains("xcode")
        || id.contains("cursor")
        || id.contains("terminal")
        || id.contains("iterm")
        || id.contains("warp")
        || id.contains("jetbrains")
        || id.contains("intellij")
    {
        return AppCategory::CodeEditor;
    }
    if id.contains("notion")
        || id.contains("bear")
        || id.contains("ulysses")
        || id.contains("obsidian")
        || id.contains("pages")
        || id.contains("textedit")
        || id.contains("notes")
        || id.contains("docs.google")
    {
        return AppCategory::Writing;
    }

    AppCategory::Other
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
