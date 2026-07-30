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
//!   plan token → proxy  (hosted `/v1/*` with the JWT as Bearer)
//!   neither    → None   (caller surfaces "add a key / sign in")
//!
//! The plan token is the `licenseKey` field of `~/.o8/entitlement.json`, written
//! by the TS entitlement layer (`src/lib/entitlement/`). Read-only here.

use std::path::PathBuf;

/// Default hosted o8 API. Overridable via
/// `O8_PROXY_URL` (matches the TS resolver default in `inference-route.ts`).
const DEFAULT_O8_API_BASE_URL: &str = "https://api.o8.run";

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
        DEFAULT_O8_API_BASE_URL
    } else {
        raw.trim()
    };
    base.trim_end_matches('/').to_string()
}

/// True when the dev "View as Free" switch (#1517) is downclamping this machine
/// to the free experience. Mirrors the TS `dev-override.ts` file: the view-as
/// switch only ever writes a DOWNGRADE, and the only plan Q previews is `free`,
/// so a `{ "plan": "free" }` override forces the free voice path. A missing file
/// (or any non-free override plan) leaves the token path unchanged. Never panics.
fn dev_override_forces_free() -> bool {
    let path = o8_data_dir().join("dev-plan-override");
    let Ok(raw) = std::fs::read_to_string(path) else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return false;
    };
    value.get("plan").and_then(|p| p.as_str()) == Some("free")
}

/// The plan-token bearer — the raw EdDSA JWT from `~/.o8/entitlement.json`
/// (`licenseKey`). Returns None unless it looks like a compact JWT (3
/// dot-separated segments); the proxy makes the real validity call.
///
/// When "View as Free" is active we return None so the managed-proxy voice paths
/// (Symon / Ask / dictation polish / Whisper STT) simulate the free experience.
/// The license FILE is never modified — clearing the override restores the perk.
pub fn read_license_token() -> Option<String> {
    if dev_override_forces_free() {
        return None;
    }
    let path = o8_data_dir().join("entitlement.json");
    let raw = std::fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let token = value.get("licenseKey")?.as_str()?.trim().to_string();
    if token.is_empty() || token.split('.').count() != 3 {
        return None;
    }
    Some(token)
}

/// The effective plan string from `~/.o8/entitlement.json` (`plan` field), or
/// None when absent/invalid. Read-only; never panics. Honors the "View as Free"
/// dev override for parity with the TS entitlement resolver. Used to tag Sentry
/// events (telemetry) — never any richer identity.
pub fn read_plan() -> Option<String> {
    if dev_override_forces_free() {
        return Some("free".to_string());
    }
    let path = o8_data_dir().join("entitlement.json");
    let raw = std::fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let plan = value.get("plan")?.as_str()?.trim().to_string();
    if plan.is_empty() {
        return None;
    }
    Some(plan)
}

/// True when a Founding Operator record exists (`~/.o8/founder.json` carries an
/// `operatorNumber`). BOOLEAN ONLY — the operator number itself is NEVER read or
/// surfaced. Never panics.
pub fn is_founder() -> bool {
    let path = o8_data_dir().join("founder.json");
    let Ok(raw) = std::fs::read_to_string(path) else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return false;
    };
    value
        .get("operatorNumber")
        .and_then(|n| n.as_i64())
        .is_some()
}

/// Where a Gemini `generateContent` call should go.
pub enum GeminiTarget {
    /// Direct Google API — authenticate in a header so diagnostics never carry
    /// the provider key as part of a URL.
    Direct { url: String, api_key: String },
    /// Managed proxy — Bearer plan token; the caller MUST add a top-level
    /// `model` field to the JSON body (Google's model lives in the URL we own).
    Proxy { url: String, token: String },
}

/// Resolve a Gemini `generateContent` route: local key → direct; else plan
/// token → proxy; else None (no key and not signed in).
pub fn resolve_gemini(model: &str) -> Option<GeminiTarget> {
    if let Some(key) = crate::stt::keys::get_gemini_key() {
        return Some(GeminiTarget::Direct {
            url: format!("https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"),
            api_key: key,
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
