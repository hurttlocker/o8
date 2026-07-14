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

mod flac;
mod prompt;
#[cfg(test)]
mod tests;

use flac::{
    wav_to_flac, ESTIMATED_UPLOAD_BYTES_PER_MS, FLAC_DECISION_MARGIN_MS,
    RAW_WAV_FAST_PATH_MAX_BYTES,
};
use prompt::{app_category, build_prompt, AppCategory};

/// Polish default. Flash-Lite (still audio + vision + text capable) won the
/// 2026-07-07 A/B decisively: 426–467ms vs 5.8–6.6s for 3-flash-preview /
/// 2.5-flash on the correction task, with the cleanest output of the three.
/// Escape hatch: set `polish_model` in the dictation config.
pub const GEMINI_MODEL: &str = crate::models::GEMINI_2_5_FLASH_LITE;

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

/// Polish model is config-overridable for latency A/Bs without a rebuild:
/// set `polish_model` in the dictation config (e.g. a flash-lite id). The
/// provider stays Gemini — the id just swaps within the same API.
pub fn load_model_config() -> PolishModelConfig {
    let mut config = PolishModelConfig::default();
    if let Some(model) = crate::stt::keys::config_string("polish_model") {
        config.model = model;
    }
    config
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
        // Available when a Gemini key is configured (direct) OR an active o8 plan
        // can serve it through the managed proxy — so a keyless founder still gets
        // polish instead of it silently disabling. resolve_gemini() covers both.
        PolishProvider::Gemini => crate::entitlement::resolve_gemini(&config.model).is_some(),
    }
}

pub fn supports_audio_context(config: &PolishModelConfig) -> bool {
    matches!(config.provider, PolishProvider::Gemini)
}

pub fn app_category_for_bundle(bundle_id: &str) -> &'static str {
    prompt::app_category_for_bundle(bundle_id)
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
    // local Gemini key → direct Google; else an active o8 plan → managed proxy;
    // else skip polish and return the raw transcript (never hard-fail dictation).
    let target = match crate::entitlement::resolve_gemini(&config.model) {
        Some(t) => t,
        None => {
            return ModelRun {
                text: ctx.transcript.to_string(),
                ..ModelRun::default()
            };
        }
    };
    let (req_url, bearer, google_api_key): (String, Option<String>, Option<String>) = match &target {
        crate::entitlement::GeminiTarget::Direct { url, api_key } => {
            (url.clone(), None, Some(api_key.clone()))
        }
        crate::entitlement::GeminiTarget::Proxy { url, token } => {
            (url.clone(), Some(token.clone()), None)
        }
    };
    let is_proxy = bearer.is_some();

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

    let mut multimodal_body = build_body(multimodal_parts);
    let mut text_only_body = build_body(vec![serde_json::json!({
        "text": build_prompt(ctx, false)
    })]);
    // The proxy owns the model in the URL — pass it in the body on that path.
    if is_proxy {
        multimodal_body["model"] = serde_json::json!(config.model);
        text_only_body["model"] = serde_json::json!(config.model);
    }

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
            let mut req = client.post(&req_url).json(body);
            if let Some(token) = &bearer {
                req = req.bearer_auth(token);
            }
            if let Some(api_key) = &google_api_key {
                req = req.header("x-goog-api-key", api_key);
            }
            match req.send() {
                Ok(response) if response.status().is_success() => {
                    return response
                        .json::<Response>()
                        .map_err(|e| format!("{label} parse error: {e}"));
                }
                Ok(response) => {
                    let status = response.status();
                    let body_text = response.text().unwrap_or_default();
                    let body_snippet = crate::utf8_head(&body_text, 200).to_string();
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
