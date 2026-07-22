//! Symon Realtime — native tool bridge (Track B, P4).
//!
//! Gives the browser-side gpt-realtime session the SAME native tools the
//! cascaded push-to-talk agent uses. The realtime model emits a `function_call`
//! on the data channel; the webview invokes `realtime_invoke_tool`, which runs
//! the exact safety gate + dispatcher the agent loop uses
//! (`confirm_if_needed` → `dispatch_tool_call`), then hands the result back for
//! the model to speak. `realtime_tools` gives the webview the tool schemas to
//! register in `session.update`.
//!
//! No agent-loop coupling: each call builds a minimal `TaskCtx` (no screen, no
//! edit context) and runs standalone. The confirm card still routes through the
//! existing dock path because the task_id is registered the same way — so a
//! Destructive tool spoken-confirms exactly like the push-to-talk path.

#![cfg(target_os = "macos")]

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::{json, Value};
use tauri::Emitter;

use super::{execute_realtime_tool_call, tools, ConfirmCorrelation, TaskCtx};

/// Monotonic per-call id source — keeps each realtime tool call's confirm card
/// addressable without pulling in `uuid` (not a dependency) or `Date`.
static REALTIME_TASK_SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Clone)]
struct RealtimeReviewGuard {
    cancel: Arc<AtomicBool>,
    task_id: Option<String>,
}

static REALTIME_REVIEW_GUARDS: OnceLock<Mutex<HashMap<String, RealtimeReviewGuard>>> =
    OnceLock::new();

fn realtime_review_guards() -> &'static Mutex<HashMap<String, RealtimeReviewGuard>> {
    REALTIME_REVIEW_GUARDS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn register_realtime_review_guard(review_guard_id: &str, task_id: &str) -> Arc<AtomicBool> {
    let mut guards = realtime_review_guards()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let guard = guards
        .entry(review_guard_id.to_string())
        .or_insert_with(|| RealtimeReviewGuard {
            cancel: Arc::new(AtomicBool::new(false)),
            task_id: None,
        });
    guard.task_id = Some(task_id.to_string());
    guard.cancel.clone()
}

fn finish_realtime_review_guard(review_guard_id: &str, task_id: &str) {
    let mut guards = realtime_review_guards()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if guards
        .get(review_guard_id)
        .and_then(|guard| guard.task_id.as_deref())
        == Some(task_id)
    {
        guards.remove(review_guard_id);
    }
}

/// Cancel one desktop-Realtime governed review across the web/native handoff.
/// A tombstone is kept when interruption beats registration, so invocation
/// order cannot resurrect a call that the operator already interrupted.
#[tauri::command]
pub fn realtime_interrupt_review(app: tauri::AppHandle, review_guard_id: String) -> bool {
    let (was_active, dismissed) = interrupt_realtime_review_inner(&review_guard_id);
    crate::tts::playback::stop();
    if let Some((task_id, confirmation_id)) = dismissed {
        super::emit_confirm_dismissed(&app, &task_id, &confirmation_id);
    }
    was_active
}

fn interrupt_realtime_review_inner(review_guard_id: &str) -> (bool, Option<(String, String)>) {
    let review_guard_id = review_guard_id.trim();
    if review_guard_id.is_empty() {
        return (false, None);
    }
    let (was_active, task_id) = {
        let mut guards = realtime_review_guards()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let guard = guards
            .entry(review_guard_id.to_string())
            .or_insert_with(|| RealtimeReviewGuard {
                cancel: Arc::new(AtomicBool::new(true)),
                task_id: None,
            });
        let was_active = guard.task_id.is_some();
        guard.cancel.store(true, Ordering::SeqCst);
        (was_active, guard.task_id.clone())
    };
    let dismissed = task_id.and_then(|task_id| {
        super::preempt_confirm_for_task(&task_id).map(|confirmation_id| (task_id, confirmation_id))
    });
    (was_active, dismissed)
}

/// The full Symon tool catalog, already OpenAI-function-shaped
/// (`{ name, description, parameters }`). The webview maps each into the
/// realtime `tools` array (adding `type: "function"`) for `session.update`.
#[tauri::command]
pub fn realtime_tools() -> Vec<Value> {
    tools::all_tools()
}

/// Execute one realtime tool call through the same gate + dispatcher the agent
/// loop uses. Never returns `Err` for a tool *failure* — failures come back as a
/// structured `{ error }` value so the model can react in conversation rather
/// than tearing down the session.
#[tauri::command]
pub async fn realtime_invoke_tool(
    app: tauri::AppHandle,
    name: String,
    args: Value,
    session_id: Option<String>,
    call_id: Option<String>,
    utterance: Option<String>,
    review_guard_id: Option<String>,
) -> Result<Value, String> {
    realtime_invoke_tool_inner(
        Some(app),
        name,
        args,
        session_id,
        call_id,
        utterance,
        review_guard_id,
    )
    .await
}

async fn realtime_invoke_tool_inner(
    app: Option<tauri::AppHandle>,
    name: String,
    args: Value,
    session_id: Option<String>,
    call_id: Option<String>,
    utterance: Option<String>,
    review_guard_id: Option<String>,
) -> Result<Value, String> {
    let seq = REALTIME_TASK_SEQ.fetch_add(1, Ordering::SeqCst);
    let task_id = format!("realtime-{seq}");
    let review_guard_id = review_guard_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let cancel = review_guard_id
        .as_deref()
        .map(|guard_id| register_realtime_review_guard(guard_id, &task_id))
        .unwrap_or_else(|| Arc::new(AtomicBool::new(false)));
    // Observability: every voice tool call + outcome lands in the app log
    // (`[symon-rt]`) so the operator's live tests are visible from the shell.
    let args_preview: String = args.to_string().chars().take(200).collect();
    log::info!("[symon-rt] tool → {name} {args_preview}");
    let ctx = TaskCtx {
        task_id: task_id.clone(),
        utterance: utterance.unwrap_or_default(),
        ledger_session_id: session_id
            .as_ref()
            .filter(|value| !value.trim().is_empty())
            .cloned(),
        app,
        screen: None,
        spatial: false,
        crop_png_base64: None,
        edit: None,
        cancel,
    };

    // Same safety gate as the cascaded loop: ReadOnly passes straight through,
    // while every mutation asks through the dock/phone Allow/Cancel gate because
    // reversible silent consent is disabled in v1. `speak=false` avoids a
    // duplicate proposal for ordinary calls. Packet approve/reject is the one
    // exception: the confirmation seam reads the trusted receipt summary after
    // Realtime audio stops, so arbitrary model speech cannot satisfy the gate.
    // Unknown tools default to Destructive, so a typo can't silently act.
    let correlation = match (session_id, call_id) {
        (Some(session_id), Some(call_id))
            if !session_id.trim().is_empty() && !call_id.trim().is_empty() =>
        {
            Some(ConfirmCorrelation {
                session_id,
                call_id,
            })
        }
        _ => None,
    };
    let output = execute_realtime_tool_call(&ctx, &name, args, correlation).await;
    if let Some(guard_id) = review_guard_id.as_deref() {
        finish_realtime_review_guard(guard_id, &task_id);
    }
    log::info!(
        "[symon-rt] tool {name} = {}",
        if output.get("error").is_some() {
            "error"
        } else {
            "ok"
        }
    );
    Ok(output)
}

/// Mirror a client-side realtime lifecycle event (status changes, function-call
/// intents, OpenAI errors) into the app log. The webview only forwards
/// `console.error` otherwise, so without this the `[realtime]` trace is invisible
/// outside the voice-settings window — this makes a live voice test observable
/// from the shell (`[symon-rt]` in `~/Library/Logs/ai.o8.desktop/o8.log`).
#[tauri::command]
pub fn record_realtime_event(line: String) {
    let trimmed: String = line.chars().take(400).collect();
    log::info!("[symon-rt] {trimmed}");
}

/// Push the live realtime-voice PRESENCE to the screen dock — the always-on
/// Symon pill — so "voice is live" shows up where Symon already lives, not only
/// inside the IDE window. The client maps its fine-grained `RealtimeStatus` down
/// to a simple `off | connecting | live | error` before calling this.
///
/// `emit_to(DOCK_LABEL, …)` is the reliable second-window path (a plain
/// broadcast has been seen to miss the dock webview — see the dock-route note in
/// `dictation-pill/page.tsx`); the broadcast twin is belt-and-suspenders for the
/// main window. Fire-and-forget.
#[tauri::command]
pub fn realtime_status_changed(app: tauri::AppHandle, status: String) {
    log::info!("[symon-rt] presence → {status}");
    let payload = json!({ "status": status });
    let _ = app.emit_to(
        crate::dock_window::DOCK_LABEL,
        "o8:realtime-status",
        payload.clone(),
    );
    let _ = app.emit("o8:realtime-status", payload);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn realtime_command_persists_phone_utterance_and_session() {
        let data_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("realtime-ledger-seam-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data_dir);
        std::fs::create_dir_all(&data_dir).unwrap();

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        super::super::store::with_test_data_dir(data_dir.clone(), || {
            runtime
                .block_on(realtime_invoke_tool_inner(
                    None,
                    "symon_ledger_recent".to_string(),
                    json!({ "limit": 3 }),
                    Some("phone-session-seam".to_string()),
                    Some("phone-call-seam".to_string()),
                    Some("what did you just do".to_string()),
                    None,
                ))
                .unwrap();
        });

        let conn = rusqlite::Connection::open(data_dir.join("agent.db")).unwrap();
        let persisted = conn
            .query_row(
                "SELECT utterance, source, session_id, call_id, phase, outcome
                 FROM agent_action_events ORDER BY seq DESC LIMIT 1",
                [],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(persisted.0.as_deref(), Some("what did you just do"));
        assert_eq!(persisted.1, "phone_realtime");
        assert_eq!(persisted.2.as_deref(), Some("phone-session-seam"));
        assert_eq!(persisted.3.as_deref(), Some("phone-call-seam"));
        assert_eq!(persisted.4, "terminal");
        assert_eq!(persisted.5, "succeeded");

        drop(conn);
        std::fs::remove_dir_all(data_dir).unwrap();
    }

    #[test]
    fn realtime_review_interrupt_cancels_active_and_late_registered_calls() {
        let active_id = format!("active-review-{}", std::process::id());
        let active = register_realtime_review_guard(&active_id, "realtime-active");
        assert!(!active.load(Ordering::SeqCst));
        assert!(interrupt_realtime_review_inner(&active_id).0);
        assert!(active.load(Ordering::SeqCst));
        finish_realtime_review_guard(&active_id, "realtime-active");

        let late_id = format!("late-review-{}", std::process::id());
        assert!(!interrupt_realtime_review_inner(&late_id).0);
        let late = register_realtime_review_guard(&late_id, "realtime-late");
        assert!(late.load(Ordering::SeqCst));
        finish_realtime_review_guard(&late_id, "realtime-late");
    }
}
