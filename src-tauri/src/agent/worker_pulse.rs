//! Worker pulse — background fleet visibility in the dock (dossier #8).
//!
//! Invisible-until-done background agents are the anti-pattern; o8's are governed
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
        if let Some((working, waiting, repos)) = snapshot {
            // Emit on change, and keep re-asserting while work is in flight so
            // a dock webview that loaded late still syncs.
            let changed = last.as_ref() != Some(&(working, waiting, repos.clone()));
            if changed || working + waiting > 0 {
                let payload = json!({
                    "count": working + waiting,
                    "working": working,
                    "waiting": waiting,
                    "repos": repos,
                });
                let _ = app.emit_to(crate::dock_window::DOCK_LABEL, "o8:worker-status", payload.clone());
                let _ = app.emit("o8:worker-status", payload);
            }
            if changed {
                log::info!(
                    "[worker-pulse] {working} working, {waiting} waiting on the operator"
                );
            }
            last = Some((working, waiting, repos));
        }

        // Sleep in 2s ticks so a nudge cuts the wait short.
        let interval_secs: u64 = match &last {
            Some((working, waiting, _)) if working + waiting > 0 => 30,
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

/// Lane statuses that are GENUINELY working — these drive the spinning orbit.
/// Counted EXPLICITLY (2026-06-22) rather than "everything minus waiting": the
/// old `total - waiting` math counted `idle`/`paused`/stopped lanes as working,
/// so a closed agent (lane left at `idle`, session=none) kept Symon's dock
/// spinning "1 working agent" while o8's own UI showed it idle — a parity break.
/// `recovering` stays working (the system is auto-retrying).
const WORKING_STATUSES: &[&str] = &[
    "running",
    "launching",
    "dispatching",
    "recovering",
    "merging",
];

/// Lane statuses parked on a HUMAN (or a review), not working — surfaced as
/// "waiting on you", never as in-flight work.
const WAITING_STATUSES: &[&str] = &[
    "awaiting_input",
    "awaiting_orchestrator",
    "awaiting_human",
    "reviewing",
    "failed",
];

/// One `/api/lanes?active=true` read → (working, waiting-on-operator, deduped
/// repo names of working+waiting lanes, max 3). Lanes that are neither working
/// nor waiting (idle / paused / stopped — present in the active set but doing
/// nothing) are surfaced as NEITHER, so a closed/dead agent stops spinning.
/// None on transport failure (server restarting, port moved) — keep the last
/// known state rather than flickering the orbit off.
async fn poll() -> Option<(usize, usize, Vec<String>)> {
    let resp = super::o8_http::get_json("/api/lanes?active=true").await.ok()?;
    let lanes = resp.get("lanes").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let mut repos: Vec<String> = Vec::new();
    let mut working = 0usize;
    let mut waiting = 0usize;
    for lane in &lanes {
        let status = lane.get("status").and_then(|v| v.as_str()).unwrap_or("");
        let is_working = WORKING_STATUSES.contains(&status);
        let is_waiting = WAITING_STATUSES.contains(&status);
        if is_working {
            working += 1;
        }
        if is_waiting {
            waiting += 1;
        }
        // Only surface a repo for a lane that is actually working or waiting —
        // an idle/paused lane shouldn't put its repo in the dock either.
        if !is_working && !is_waiting {
            continue;
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
    Some((working, waiting, repos))
}
