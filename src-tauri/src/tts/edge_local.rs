//! Free neural male voice via the bundled server's /api/tts (edge-tts →
//! en-US-SteffanNeural — the Mister reading voice).
//!
//! The Rust read-back chain was ElevenLabs (premium key) → Google (key) →
//! macOS `say`, which on a keyless FREE machine skipped every neural voice and
//! landed on the system default — a woman's voice, nothing like the product's
//! (operator report 2026-07-12, free MacBook, read-back chord). The node side
//! has always had the free Steffan voice for the play button; this bridges the
//! Rust chain to it over loopback (which passes the API gate by design) so
//! keyless machines read back in the same voice as everyone else. Failure here
//! still falls through to `say` — the always-works floor.

const STEFFAN_VOICE: &str = "en-US-SteffanNeural";

/// Synthesize `text` → MP3 bytes via the local /api/tts route. Errors are
/// `String`, matching the sibling providers.
pub async fn synthesize(text: &str) -> Result<Vec<u8>, String> {
    let port = crate::resolve_api_port();
    let url = format!("http://127.0.0.1:{port}/api/tts");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("edge-local client: {e}"))?;
    let resp = client
        .post(&url)
        .json(&serde_json::json!({ "text": text, "voice": STEFFAN_VOICE }))
        .send()
        .await
        .map_err(|e| format!("edge-local request: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("edge-local status {}", resp.status()));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("edge-local body: {e}"))?;
    if bytes.is_empty() {
        return Err("edge-local returned empty audio".to_string());
    }
    Ok(bytes.to_vec())
}
