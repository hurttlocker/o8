//! Symon voice-agent model routing.
//!
//! The tool-calling loop's model is config-driven so the brain is a one-flip
//! change: edit `~/.o8/agent_models.json` and set `mac_native_action`. The
//! default ships on `gemini-3-flash-preview` via the DIRECT Google API (o8
//! already holds a working Gemini key for Ask; cheap, fast, no proxy). A model
//! id containing `/` routes to OpenRouter (e.g. `openai/gpt-4o-mini`) once that
//! account has credits — the one-flip A/B.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AgentModelConfig {
    /// The tool-calling loop brain. `/`-in-id → OpenRouter, `claude…` → Claude
    /// text-planner brain, else Gemini.
    pub mac_native_action: String,
    /// Two-tier escalation policy: "off" (front brain handles everything inline,
    /// the `escalate` handoff is withheld), "auto" (escalate heavy multi-step
    /// tasks — default), or "deep" (also bias medium tasks to the background
    /// brain). Read by the front brains (gemini/openrouter); the Claude brain is
    /// the background target and never escalates.
    pub voice_escalation: String,
    /// Reserved for later lanes (not read by the V1 loop). Kept so an existing
    /// aqua-shaped `agent_models.json` parses unchanged.
    pub intent_classification: String,
    pub result_summarization: String,
}

impl Default for AgentModelConfig {
    fn default() -> Self {
        Self {
            mac_native_action: "gemini-3-flash-preview".to_string(),
            voice_escalation: "auto".to_string(),
            intent_classification: "gemini-3-flash-preview".to_string(),
            result_summarization: "gemini-3-flash-preview".to_string(),
        }
    }
}

/// Load the agent model config from `~/.o8/agent_models.json`, falling back to
/// defaults when the file is absent or malformed. `#[serde(default)]` lets a
/// partial file (e.g. only `mac_native_action`) parse cleanly.
pub fn load_config() -> AgentModelConfig {
    let path = super::agent_data_dir().join("agent_models.json");
    match std::fs::read_to_string(&path) {
        Ok(contents) => serde_json::from_str(&contents).unwrap_or_else(|e| {
            log::warn!("[symon-agent] agent_models.json parse error: {e} — using defaults");
            AgentModelConfig::default()
        }),
        Err(_) => AgentModelConfig::default(),
    }
}
