//! API key + preference resolution for the o8 STT engine.
//!
//! This is the de-Symonized replacement for aqua's `keys.rs` /
//! `product_mode.rs` / license logic. There is NO proxy, NO license token,
//! NO product-mode gate — both resolvers read an environment variable first,
//! then fall back to a small JSON config under `~/.o8`. They are UN-GATED so
//! they work in release builds (signed, Finder-launched).
//!
//! `GEMINI_API_KEY` powers transcript polish; `OPENROUTER_API_KEY` powers the
//! optional Whisper re-transcription pass. The Tauri sidecar already forwards
//! both vars from the user's login shell into this process (see
//! `load_ai_keys_from_login_shell` in `lib.rs`), so a key in `~/.zshenv`
//! reaches a Finder-launched build without any extra config file.

use std::path::PathBuf;
use std::sync::OnceLock;

/// Canonical o8 data dir (`~/.o8`, overridable via env). Mirrors the resolver
/// in `lib.rs` but does NOT trigger the cortex-ide → o8 migration — STT only
/// reads a single config file, so the lighter resolver keeps it dependency-free.
fn o8_data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("O8_DATA_DIR") {
        return PathBuf::from(dir);
    }
    if let Ok(dir) = std::env::var("CORTEX_IDE_DATA_DIR") {
        return PathBuf::from(dir);
    }
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join(".o8")
}

/// Path to the optional STT config file: `~/.o8/dictation.json`.
fn config_path() -> PathBuf {
    o8_data_dir().join("dictation.json")
}

/// Lazily-loaded `~/.o8/dictation.json` as a JSON object. Cached for the
/// process lifetime — STT prefs don't change mid-run, and re-reading on every
/// dictation would add disk latency to the hot path.
fn config() -> &'static serde_json::Value {
    static CONFIG: OnceLock<serde_json::Value> = OnceLock::new();
    CONFIG.get_or_init(|| {
        std::fs::read_to_string(config_path())
            .ok()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
            .unwrap_or(serde_json::Value::Null)
    })
}

/// Read a string value from `~/.o8/dictation.json`, empty strings filtered out.
pub fn config_string(key: &str) -> Option<String> {
    config()
        .get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
}

/// Resolve the Gemini API key. Env-first (`GEMINI_API_KEY`), then the o8
/// config file. UN-GATED — no dev gate, no product-mode check, works in
/// release.
pub fn get_gemini_key() -> Option<String> {
    std::env::var("GEMINI_API_KEY")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| config_string("gemini_api_key"))
}

/// Resolve the OpenRouter API key. Env-first (`OPENROUTER_API_KEY`), then the
/// o8 config file. UN-GATED — works in release.
pub fn get_openrouter_key() -> Option<String> {
    std::env::var("OPENROUTER_API_KEY")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| config_string("openrouter_api_key"))
}
