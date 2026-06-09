//! Symon — o8's voice-activated, tool-calling agent.
//!
//! A distinct voice agent (NOT the orchestrator): a fast OpenRouter brain runs a
//! ~10-turn function-calling loop over native macOS tools, gated by a SafetyClass
//! confirm card in the dock, then speaks the result. Lifted from the acquired
//! aqua/Symon app and de-Symonized onto o8's `~/.o8` data dir + dock event
//! plumbing. macOS-only (gated at the `mod agent;` declaration in lib.rs).
//!
//! Threading: `agent_run` (a SYNC Tauri command) spawns a worker thread that
//! builds its own current-thread tokio runtime and `block_on`s `run_agent` —
//! mirroring `spawn_ask_and_speak`. The confirm round-trip uses a `std::sync`
//! registry of oneshot senders so the SYNC `agent_confirm` command can resolve
//! the loop's `await` from a different thread.

pub mod gemini;
pub mod openrouter;
pub mod router;
pub mod safety;
pub mod store;
pub mod tools;

use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::Emitter;
use tokio::sync::oneshot;

const CONFIRM_TIMEOUT_SECS: u64 = 120;

/// Per-task context threaded into the loop + tool dispatch.
#[derive(Clone)]
pub struct TaskCtx {
    pub task_id: String,
    pub app: tauri::AppHandle,
}

/// Result of one agent reasoning loop (shared by both providers).
pub struct LoopResult {
    pub result_text: String,
    pub model_used: String,
    /// JSON array of `{tool, args}` — persisted for the task ledger.
    pub tool_calls_json: String,
}

/// Shared system prompt: the agent persona + current-time grounding. Spoken
/// aloud, so it asks for short, markdown-free replies.
pub(crate) fn system_prompt() -> String {
    let when = chrono::Local::now().format("%A, %B %-d %Y, %-I:%M %p").to_string();
    format!(
        "You are Symon, a fast, helpful macOS voice assistant for o8. You control \
         the user's Mac through native tools (Reminders, Calendar, Notes, opening \
         apps). Use the tools to actually DO what the user asks — don't just \
         describe the steps. Give reminders and events a clear, specific Title Case \
         title. When a tool needs a date or time, resolve it relative to the \
         current local time and emit an ISO 8601 string (e.g. 2026-06-09T15:00:00). \
         Your reply is spoken aloud, so keep it to one or two short, conversational \
         sentences with no markdown. The current local time is {when}."
    )
}

/// Resolve the o8 data dir (`$HOME/.o8`), matching `stt::keys`.
pub fn agent_data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("O8_DATA_DIR") {
        return PathBuf::from(dir);
    }
    if let Ok(dir) = std::env::var("CORTEX_IDE_DATA_DIR") {
        return PathBuf::from(dir);
    }
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join(".o8")
}

// ── task ids ─────────────────────────────────────────────────────────────────

static TASK_COUNTER: AtomicU64 = AtomicU64::new(0);

fn next_task_id() -> String {
    let n = TASK_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("task-{}-{}", store::now_ts(), n)
}

// ── confirm registry ─────────────────────────────────────────────────────────
// `Vec::new()` is const so this initializes without a OnceLock. n is tiny
// (≤ pending confirms across active tasks), so linear scan is fine.

static CONFIRM_CHANNELS: Mutex<Vec<(String, oneshot::Sender<bool>)>> = Mutex::new(Vec::new());

/// Gate a tool call on its SafetyClass. ReadOnly (and consented Reversible) run
/// immediately. Otherwise emit a confirm card to the dock and block on a oneshot
/// the user resolves via `agent_confirm` — declining on cancel / 2-min timeout.
pub async fn confirm_if_needed(ctx: &TaskCtx, tool_name: &str, args: &Value) -> bool {
    let class = safety::tool_safety_class(tool_name);
    if !safety::requires_confirmation(class, safety::reversible_silent_consent()) {
        return true;
    }

    let (tx, rx) = oneshot::channel();
    {
        let mut chans = CONFIRM_CHANNELS.lock().unwrap_or_else(|p| p.into_inner());
        // Drop any stale entry for this task before registering the new one.
        chans.retain(|(id, _)| id != &ctx.task_id);
        chans.push((ctx.task_id.clone(), tx));
    }

    emit_confirm(
        &ctx.app,
        json!({
            "taskId": ctx.task_id,
            "tool": tool_name,
            "summary": confirm_summary(tool_name, args),
        }),
    );

    let approved = tokio::select! {
        decision = rx => decision.unwrap_or(false),
        _ = tokio::time::sleep(std::time::Duration::from_secs(CONFIRM_TIMEOUT_SECS)) => false,
    };

    // Clean up if the timeout path left the sender registered.
    {
        let mut chans = CONFIRM_CHANNELS.lock().unwrap_or_else(|p| p.into_inner());
        chans.retain(|(id, _)| id != &ctx.task_id);
    }
    approved
}

/// Resolve a pending confirm — called by the SYNC `agent_confirm` command.
/// `oneshot::Sender::send` is synchronous, so this needs no async context.
pub fn resolve_confirm(task_id: &str, allow: bool) {
    let sender = {
        let mut chans = CONFIRM_CHANNELS.lock().unwrap_or_else(|p| p.into_inner());
        chans
            .iter()
            .position(|(id, _)| id == task_id)
            .map(|pos| chans.remove(pos).1)
    };
    if let Some(tx) = sender {
        let _ = tx.send(allow);
    }
}

/// Human phrasing for a confirm card.
fn confirm_summary(tool_name: &str, args: &Value) -> String {
    let s = |k: &str| args.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    match tool_name {
        "mac_reminders_create" => {
            let title = s("title");
            let due = s("due_date");
            if due.is_empty() {
                format!("Create a reminder “{title}”")
            } else {
                format!("Create a reminder “{title}” for {due}")
            }
        }
        "mac_calendar_create_event" => format!("Add “{}” to your calendar", s("title")),
        "mac_notes_create" => format!("Create a note “{}”", s("title")),
        "mac_reminders_complete" => format!("Mark “{}” complete", s("title")),
        other => format!("Run {other}"),
    }
}

// ── dock events ──────────────────────────────────────────────────────────────
// Dual-emit (emit_to dock + broadcast) — the dock is a second webview that a
// bare `emit` can miss. Mirrors lib.rs's `emit_stt`.

pub fn emit_agent_event(app: &tauri::AppHandle, payload: Value) {
    let _ = app.emit_to(crate::dock_window::DOCK_LABEL, "o8:agent-task-event", payload.clone());
    let _ = app.emit("o8:agent-task-event", payload);
}

fn emit_confirm(app: &tauri::AppHandle, payload: Value) {
    let _ = app.emit_to(crate::dock_window::DOCK_LABEL, "o8:agent-confirm", payload.clone());
    let _ = app.emit("o8:agent-confirm", payload);
}

// ── orchestration ────────────────────────────────────────────────────────────

/// Run one agent task to completion: persist → run the loop → persist result →
/// speak it → notify. Called inside a worker thread's current-thread runtime.
pub async fn run_agent(app: tauri::AppHandle, prompt: String) -> Result<String, String> {
    let prompt = prompt.trim().to_string();
    if prompt.is_empty() {
        return Err("Empty request".into());
    }

    let task_id = next_task_id();
    let ctx = TaskCtx { task_id: task_id.clone(), app: app.clone() };

    store::insert_task(&task_id, &prompt);
    emit_agent_event(
        &app,
        json!({ "taskId": task_id, "kind": "status", "status": "running", "intent": prompt }),
    );
    crate::sound::play_sound("Pop");

    // Route by model id: `/` → OpenRouter (e.g. openai/gpt-4o-mini), else direct
    // Gemini (e.g. gemini-3-flash-preview). A one-flip change in agent_models.json.
    let model = router::load_config().mac_native_action;
    let loop_result = if model.contains('/') {
        openrouter::run_loop(&model, &prompt, &ctx).await
    } else {
        gemini::run_loop(&model, &prompt, &ctx).await
    };

    match loop_result {
        Ok(result) => {
            store::finish_task(
                &task_id,
                "done",
                &result.result_text,
                &result.model_used,
                &result.tool_calls_json,
            );
            emit_agent_event(
                &app,
                json!({ "taskId": task_id, "kind": "status", "status": "done", "result": result.result_text }),
            );
            if !result.result_text.trim().is_empty() {
                crate::tts::playback::play_thread(result.result_text.clone(), crate::tts::load_config());
            }
            notify_done(&result.result_text);
            Ok(result.result_text)
        }
        Err(e) => {
            store::finish_task(&task_id, "failed", &e, &model, "[]");
            emit_agent_event(
                &app,
                json!({ "taskId": task_id, "kind": "status", "status": "failed", "result": e }),
            );
            Err(e)
        }
    }
}

/// Spawn an agent task on a dedicated OS thread with its own current-thread
/// tokio runtime (mirrors `spawn_ask_and_speak`). Fire-and-forget: results reach
/// the user via dock events + TTS.
pub fn spawn_agent(app: tauri::AppHandle, prompt: String) {
    let prompt = prompt.trim().to_string();
    if prompt.is_empty() {
        return;
    }
    std::thread::spawn(move || {
        let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
            Ok(rt) => rt,
            Err(e) => {
                log::error!("[symon-agent] failed to build runtime: {e}");
                return;
            }
        };
        log::info!("[symon-agent] intent: {} chars", prompt.len());
        match rt.block_on(async { run_agent(app, prompt).await }) {
            Ok(text) => log::info!("[symon-agent] done: {} chars", text.len()),
            Err(e) => log::warn!("[symon-agent] failed: {e}"),
        }
    });
}

/// Native macOS completion notification.
fn notify_done(result: &str) {
    let body = result
        .chars()
        .take(120)
        .collect::<String>()
        .replace('\\', "/")
        .replace('"', "'");
    let script = format!("display notification \"{body}\" with title \"Symon\"");
    let _ = std::process::Command::new("osascript").args(["-e", &script]).output();
}
