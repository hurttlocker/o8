//! Warm `claude` session pool for the Symon voice agent (#1252 speed pass).
//!
//! The agent's `claude` CLI pays ~1-2s of bootstrap per spawn. The persistent
//! `ClaudeSession` (claude.rs) already cut that to once per task; this pool moves
//! even that one boot off the critical path by pre-spawning on the Left-Option
//! keydown — the proc boots while speech-to-text is still recording, so by the
//! time the prompt is assembled it's waiting.
//!
//! Depth-1 warm slot (one idle session is plenty for a single-operator voice
//! agent): `prewarm` boots it, `acquire` takes it (warm hit) or cold-spawns,
//! then refills in the background so back-to-back tasks stay warm. A stale
//! (>WARM_TTL) or dead idle session is discarded on access and respawned; a
//! never-consumed idle proc is replaced by the next keydown's prewarm. Keyed by
//! model — every agent path uses the same Opus brain, so one slot covers it.
//!
//! Mirrors the spirit of `src/lib/claude-code/warm-repl-pool.ts` (the Brain's
//! pool), but that one is SINGLE-USE (stateless Q&A); the agent's sessions are
//! taken for a whole multi-turn task, then dropped — they carry task context and
//! are never returned to the slot.

use super::claude::ClaudeSession;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Idle warm sessions older than this are treated as stale — the CLI may
/// idle-time-out its own session, so respawn rather than hand out a dead proc.
const WARM_TTL: Duration = Duration::from_secs(4 * 60);

struct WarmEntry {
    session: ClaudeSession,
    at: Instant,
}

static WARM_SLOT: Mutex<Option<WarmEntry>> = Mutex::new(None);

fn slot() -> std::sync::MutexGuard<'static, Option<WarmEntry>> {
    WARM_SLOT.lock().unwrap_or_else(|p| p.into_inner())
}

/// Boot a warm session for `model` unless the slot already holds a fresh,
/// matching, live one. Fire-and-forget — called on the Option keydown and to
/// refill after an `acquire`. Safe to call repeatedly.
pub fn prewarm(bin: &str, model: &str, mcp_cfg: &str) {
    {
        let mut guard = slot();
        if let Some(entry) = guard.as_mut() {
            if entry.session.model == model
                && entry.at.elapsed() < WARM_TTL
                && entry.session.is_alive()
            {
                return; // already warm for this model
            }
        }
        // Drop any stale / dead / mismatched occupant before spawning (its Drop
        // kills the proc) so we never hold two idle procs.
        *guard = None;
    }
    match ClaudeSession::spawn(bin, model, mcp_cfg) {
        Ok(session) => {
            *slot() = Some(WarmEntry { session, at: Instant::now() });
            log::info!("[symon-agent] pre-warmed {model} session");
        }
        Err(e) => log::warn!("[symon-agent] prewarm spawn failed: {e}"),
    }
}

/// Take a warm session for `model` (warm hit) or cold-spawn one, then refill the
/// slot in the background so the next task/keydown is warm too. Returns None only
/// if the cold spawn also fails.
pub fn acquire(bin: &str, model: &str, mcp_cfg: &str) -> Option<ClaudeSession> {
    let warm = match slot().take() {
        Some(mut entry) => {
            if entry.session.model == model
                && entry.at.elapsed() < WARM_TTL
                && entry.session.is_alive()
            {
                log::info!(
                    "[symon-agent] warm session hit (age {:.1}s)",
                    entry.at.elapsed().as_secs_f64()
                );
                Some(entry.session)
            } else {
                None // stale/dead/mismatch — dropped here, proc killed
            }
        }
        None => None,
    };

    let session = warm.or_else(|| match ClaudeSession::spawn(bin, model, mcp_cfg) {
        Ok(s) => {
            log::info!("[symon-agent] cold session spawn (no warm hit)");
            Some(s)
        }
        Err(e) => {
            log::warn!("[symon-agent] cold session spawn failed: {e}");
            None
        }
    });

    // Refill so the NEXT task/keydown finds a warm one — it boots during this task.
    let (b, m, c) = (bin.to_string(), model.to_string(), mcp_cfg.to_string());
    std::thread::spawn(move || prewarm(&b, &m, &c));

    session
}

/// Keydown convenience: resolve the agent's bin/model/mcp and warm a session.
/// Only warms the CLAUDE brain — when the configured front brain is Gemini or an
/// OpenRouter id, no `claude` proc is used, so warming would just leak one.
/// Called from the Right-Option down edge (`fn_hotkey::begin_agent_dictation`).
pub fn prewarm_agent() {
    let model = super::router::load_config().mac_native_action;
    if model.contains('/') || !model.starts_with("claude") {
        return;
    }
    let bin = super::claude::claude_bin();
    match super::claude::ensure_empty_mcp_config() {
        Ok(mcp) => prewarm(&bin, &model, &mcp),
        Err(e) => log::warn!("[symon-agent] prewarm_agent: mcp config failed: {e}"),
    }
}

/// Control+Fn uses the fast Sonnet 5 subscription session for prompt adjustment.
/// Repo-grounded composition can move back to Opus when that context is added.
pub fn prewarm_smart_compose() {
    let bin = super::claude::claude_bin();
    match super::claude::ensure_empty_mcp_config() {
        Ok(mcp) => prewarm(&bin, crate::models::CLAUDE_SONNET_5, &mcp),
        Err(e) => log::warn!("[symon-agent] Smart Compose prewarm failed: {e}"),
    }
}
