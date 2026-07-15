//! Symon voice-agent model routing.
//!
//! The tool-calling loop's model is config-driven so the brain is a one-flip
//! change: edit `~/.o8/agent_models.json` and set `mac_native_action`. The
//! default ships on `claude-sonnet-5` for the low-context Control+Fn lane, and
//! it sees screenshots directly via the CLI stream-json image block (#1252),
//! sub-billed on the user's Claude subscription. Set `gemini-3-flash-preview`
//! for the fast-path. A model id containing `/`
//! routes to OpenRouter — the one-flip A/B.

use serde::{Deserialize, Serialize};
use crate::models::{
    AGENT_INTENT_CLASSIFICATION_DEFAULT,
    AGENT_MAC_NATIVE_ACTION_DEFAULT,
    AGENT_RESULT_SUMMARIZATION_DEFAULT,
};

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
            mac_native_action: AGENT_MAC_NATIVE_ACTION_DEFAULT.to_string(),
            voice_escalation: "auto".to_string(),
            intent_classification: AGENT_INTENT_CLASSIFICATION_DEFAULT.to_string(),
            result_summarization: AGENT_RESULT_SUMMARIZATION_DEFAULT.to_string(),
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

/// Persist a new escalation policy into `agent_models.json`, preserving the
/// rest of the config (writes a full config from defaults if the file is
/// absent). Accepts "off" | "auto" | "deep".
pub fn set_voice_escalation(policy: &str) -> Result<(), String> {
    let mut cfg = load_config();
    cfg.voice_escalation = policy.to_string();
    let path = super::agent_data_dir().join("agent_models.json");
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let json =
        serde_json::to_string_pretty(&cfg).map_err(|e| format!("serialize agent config: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("write agent_models.json: {e}"))?;
    Ok(())
}
