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

use super::{confirm_if_needed, tools, TaskCtx};

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
) -> Result<Value, String> {
    let seq = REALTIME_TASK_SEQ.fetch_add(1, Ordering::SeqCst);
    let ctx = TaskCtx {
        task_id: format!("realtime-{seq}"),
        app,
        screen: None,
        edit: None,
        cancel: Arc::new(AtomicBool::new(false)),
    };

    // Same safety gate as the cascaded loop: ReadOnly passes straight through,
    // Reversible honors the silent-consent toggle, Destructive always asks
    // (spoken proposal + dock Allow/Cancel card). Unknown tools default to
    // Destructive, so a typo can't silently act.
    if !confirm_if_needed(&ctx, &name, &args).await {
        return Ok(json!({ "error": "User declined this action", "declined_by_user": true }));
    }

    match tools::dispatch_tool_call(&name, args, &ctx).await {
        Ok(output) => Ok(output),
        Err(e) => Ok(json!({ "error": e })),
    }
}
