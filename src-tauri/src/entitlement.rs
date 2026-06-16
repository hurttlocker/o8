//! Plan-token (EdDSA license JWT) + managed-inference proxy routing.
//!
//! When the user has NO local provider key but DOES have an active o8 plan, the
//! Rust voice surface (Symon agent, Ask, dictation polish, Whisper STT) routes
//! through the o8 managed-inference proxy instead of failing. The proxy meters
//! the call server-side against the plan's daily cap and bills OUR funded key —
//! "you pay o8 only when o8 spends for you."
//!
//! Resolution order mirrors the TS `inference-route.ts`:
//!   local key  → direct (founder / BYOK; unchanged)
//!   plan token → proxy  (Railway `/v1/*` with the JWT as Bearer)
//!   neither    → None   (caller surfaces "add a key / sign in")
//!
//! The plan token is the `licenseKey` field of `~/.o8/entitlement.json`, written
//! by the TS entitlement layer (`src/lib/entitlement/`). Read-only here.

use std::path::PathBuf;

/// Default managed-inference proxy (the o8 license server). Overridable via
/// `O8_PROXY_URL` (matches the TS resolver default in `inference-route.ts`).
const DEFAULT_PROXY_BASE: &str = "https://o8-license-server-production.up.railway.app";

/// Canonical o8 data dir (`~/.o8`, overridable). Mirrors `stt::keys::o8_data_dir`
/// — kept local so this module stays dependency-free.
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

/// Base URL of the managed-inference proxy, trailing slashes trimmed.
pub fn proxy_base_url() -> String {
    let raw = std::env::var("O8_PROXY_URL").unwrap_or_default();
    let base = if raw.trim().is_empty() {
        DEFAULT_PROXY_BASE
    } else {
        raw.trim()
    };
    base.trim_end_matches('/').to_string()
}

/// The plan-token bearer — the raw EdDSA JWT from `~/.o8/entitlement.json`
/// (`licenseKey`). Returns None unless it looks like a compact JWT (3
/// dot-separated segments); the proxy makes the real validity call.
pub fn read_license_token() -> Option<String> {
    let path = o8_data_dir().join("entitlement.json");
    let raw = std::fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let token = value.get("licenseKey")?.as_str()?.trim().to_string();
    if token.is_empty() || token.split('.').count() != 3 {
        return None;
    }
    Some(token)
}

/// Where a Gemini `generateContent` call should go.
pub enum GeminiTarget {
    /// Direct Google API — the key is already in the URL; send the body unchanged.
    Direct { url: String },
    /// Managed proxy — Bearer plan token; the caller MUST add a top-level
    /// `model` field to the JSON body (Google's model lives in the URL we own).
    Proxy { url: String, token: String },
}

/// Resolve a Gemini `generateContent` route: local key → direct; else plan
/// token → proxy; else None (no key and not signed in).
pub fn resolve_gemini(model: &str) -> Option<GeminiTarget> {
    if let Some(key) = crate::stt::keys::get_gemini_key() {
        return Some(GeminiTarget::Direct {
            url: format!(
                "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}"
            ),
        });
    }
    let token = read_license_token()?;
    Some(GeminiTarget::Proxy {
        url: format!("{}/v1/gemini", proxy_base_url()),
        token,
    })
}

/// A resolved Bearer-auth HTTP target (OpenRouter audio / transcribe).
pub struct BearerTarget {
    pub url: String,
    pub bearer: String,
}

/// Resolve the Whisper transcription route: local OpenRouter key → direct; else
/// plan token → proxy `/v1/transcribe`; else None. Body + headers are identical
/// either way — only the URL + bearer change.
pub fn resolve_transcribe() -> Option<BearerTarget> {
    if let Some(key) = crate::stt::keys::get_openrouter_key() {
        return Some(BearerTarget {
            url: "https://openrouter.ai/api/v1/audio/transcriptions".to_string(),
            bearer: key,
        });
    }
    let token = read_license_token()?;
    Some(BearerTarget {
        url: format!("{}/v1/transcribe", proxy_base_url()),
        bearer: token,
    })
}
