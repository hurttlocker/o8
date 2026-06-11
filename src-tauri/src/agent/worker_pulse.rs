//! Worker pulse — background fleet visibility in the dock (dossier #8).
//!
//! a voice competitor's background agents are invisible-until-done; o8's are governed
//! AND visible. A lightweight poller reads `/api/lanes?active=true` (the same
//! loopback route the `o8_status` tool uses) and emits `o8:worker-status`
//! `{ count, repos }` so the idle sliver can carry the slow orbiting dot +
//! count while packets are in flight — whether they were dispatched by voice
//! (`o8_dispatch`) or from the desktop.
//!
//! Cadence: 30s while work is in flight, 90s when quiet — one loopback GET,
//! negligible. `nudge()` (called after a successful `o8_dispatch`) forces an
//! immediate poll so the orbit appears within ~2s of the confirm.

use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Emitter;

static NUDGE: AtomicBool = AtomicBool::new(false);

/// Force the next poll to run immediately (≤2s) — call after a dispatch.
pub fn nudge() {
    NUDGE.store(true, Ordering::SeqCst);
}

/// Spawn the poller on its own OS thread (current-thread tokio runtime,
/// mirroring `spawn_agent`). Call once from setup after the bundled server is up.
pub fn spawn(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
            Ok(rt) => rt,
            Err(e) => {
                log::error!("[worker-pulse] failed to build runtime: {e}");
                return;
            }
        };
        rt.block_on(run(app));
    });
}

async fn run(app: tauri::AppHandle) {
    let mut last: Option<(usize, usize, Vec<String>)> = None;
    loop {
        let snapshot = poll().await;
        if let Some((count, waiting, repos)) = snapshot {
            // Emit on change, and keep re-asserting while work is in flight so
            // a dock webview that loaded late still syncs.
            let changed = last.as_ref() != Some(&(count, waiting, repos.clone()));
            if changed || count > 0 {
                let payload = json!({
                    "count": count,
                    "working": count.saturating_sub(waiting),
                    "waiting": waiting,
                    "repos": repos,
                });
                let _ = app.emit_to(crate::dock_window::DOCK_LABEL, "o8:worker-status", payload.clone());
                let _ = app.emit("o8:worker-status", payload);
            }
            if changed {
                log::info!(
                    "[worker-pulse] {} working, {waiting} waiting on the operator",
                    count.saturating_sub(waiting)
                );
            }
            last = Some((count, waiting, repos));
        }

        // Sleep in 2s ticks so a nudge cuts the wait short.
        let interval_secs: u64 = match &last {
            Some((count, _, _)) if *count > 0 => 30,
            _ => 90,
        };
        for _ in 0..(interval_secs / 2) {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            if NUDGE.swap(false, Ordering::SeqCst) {
                break;
            }
        }
    }
}

/// Lane statuses that are parked on a HUMAN (or a review), not working — the
/// dock must not present these as "in flight" (live-hit: two lanes sat in
/// reviewing/awaiting_input for half an hour while the sliver implied active
/// work). `recovering` stays "working": the system is auto-retrying.
const WAITING_STATUSES: &[&str] = &[
    "awaiting_input",
    "awaiting_orchestrator",
    "awaiting_human",
    "reviewing",
    "failed",
];

/// One `/api/lanes?active=true` read → (total, waiting-on-operator, deduped
/// repo names, max 3). None on transport failure (server restarting, port
/// moved) — keep the last known state rather than flickering the orbit off.
async fn poll() -> Option<(usize, usize, Vec<String>)> {
    let resp = super::o8_http::get_json("/api/lanes?active=true").await.ok()?;
    let lanes = resp.get("lanes").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let mut repos: Vec<String> = Vec::new();
    let mut waiting = 0usize;
    for lane in &lanes {
        let status = lane.get("status").and_then(|v| v.as_str()).unwrap_or("");
        if WAITING_STATUSES.contains(&status) {
            waiting += 1;
        }
        let repo = lane
            .get("repoPath")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap_or("")
            .to_string();
        if !repo.is_empty() && !repos.contains(&repo) && repos.len() < 3 {
            repos.push(repo);
        }
    }
    Some((lanes.len(), waiting, repos))
}
