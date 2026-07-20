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

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::Emitter;

use super::{confirm_if_needed_opts_correlated, tools, ConfirmCorrelation, TaskCtx};

/// Monotonic per-call id source — keeps each realtime tool call's confirm card
/// addressable without pulling in `uuid` (not a dependency) or `Date`.
static REALTIME_TASK_SEQ: AtomicU64 = AtomicU64::new(0);

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
) -> Result<Value, String> {
    let seq = REALTIME_TASK_SEQ.fetch_add(1, Ordering::SeqCst);
    // Observability: every voice tool call + outcome lands in the app log
    // (`[symon-rt]`) so the operator's live tests are visible from the shell.
    let args_preview: String = args.to_string().chars().take(200).collect();
    log::info!("[symon-rt] tool → {name} {args_preview}");
    let ctx = TaskCtx {
        task_id: format!("realtime-{seq}"),
        app,
        screen: None,
        spatial: false,
        crop_png_base64: None,
        edit: None,
        cancel: Arc::new(AtomicBool::new(false)),
    };

    // Same safety gate as the cascaded loop: ReadOnly passes straight through,
    // while every mutation asks through the dock/phone Allow/Cancel gate because
    // reversible silent consent is disabled in v1. `speak=false` — the realtime model announces
    // its own intent in its own voice, so we don't read the proposal with a
    // second (ElevenLabs) voice over the conversation. Unknown tools default to
    // Destructive, so a typo can't silently act.
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
    if !confirm_if_needed_opts_correlated(&ctx, &name, &args, false, correlation).await {
        log::info!("[symon-rt] tool {name} = declined");
        return Ok(json!({ "error": "User declined this action", "declined_by_user": true }));
    }

    match tools::dispatch_tool_call(&name, args, &ctx).await {
        Ok(output) => {
            log::info!(
                "[symon-rt] tool {name} = {}",
                if output.get("error").is_some() { "error" } else { "ok" }
            );
            Ok(output)
        }
        Err(e) => {
            log::warn!("[symon-rt] tool {name} = err: {e}");
            Ok(json!({ "error": e }))
        }
    }
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
    let _ = app.emit_to(crate::dock_window::DOCK_LABEL, "o8:realtime-status", payload.clone());
    let _ = app.emit("o8:realtime-status", payload);
}
