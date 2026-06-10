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

pub mod eval;
pub mod gemini;
pub mod o8_http;
pub mod openrouter;
pub mod router;
pub mod safety;
pub mod screen;
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
    /// Intent-gated screenshot of the cursor's monitor (dossier #2) — attached
    /// to the model request and used to map `[POINT:...]` tags back to screen
    /// coordinates. None unless the prompt referenced the screen.
    pub screen: Option<std::sync::Arc<screen::ScreenContext>>,
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
         apps). You are also the operator's link into o8 itself: use `o8_status` \
         to report what o8's autonomous coding agents are working on right now \
         (\"what's shipping?\"), and `o8_ask` to ask o8's Engineering Brain about \
         the code, recent work, or the fleet (\"what did Codex do today?\"). You \
         are NOT the coder — when the user wants code written or changed, that is \
         the orchestrator's job, not yours. Use the tools to actually DO what the \
         user asks — don't just describe the steps. Give reminders and events a \
         clear, specific Title Case title. When a tool needs a date or time, \
         resolve it relative to the current local time and emit an ISO 8601 string \
         (e.g. 2026-06-09T15:00:00). Your reply is spoken aloud, so keep it to one \
         or two short, conversational sentences with no markdown. The current local \
         time is {when}."
    )
}

/// Appended to the system prompt when a screenshot rides the request — teaches
/// the model the screenshot's pixel space and the `[POINT:x,y:label]` tag
/// protocol (parsed + stripped by `point_overlay::parse_point_tags`; the tags
/// animate the Symon Points overlay, never reach TTS).
pub(crate) fn screen_prompt_section(img_w: u32, img_h: u32) -> String {
    format!(
        "A screenshot of the user's current screen is attached ({img_w}x{img_h} \
         pixels). Use it to answer questions about what is on screen. You can \
         also POINT at the screen: include a tag like [POINT:x,y:label] inline \
         in your reply — x,y in screenshot pixels, label 1-3 words naming the \
         target. Use ONE tag to answer a single \"where is it\" question; for a \
         walkthrough use up to 5 tags in the order the user should follow. The \
         tags are stripped before your reply is spoken and animate a pointer on \
         the user's screen, so phrase the sentence naturally (\"it's right here, \
         in the top right\")."
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

    // Speak the proposal aloud before showing the card (fire-and-forget). The
    // card remains the binding gate — this just lets the user hear what's about
    // to happen (esp. the repo on an o8_dispatch) and catch a mishear by ear.
    crate::tts::playback::play_thread(confirm_spoken(tool_name, args), crate::tts::load_config());

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
        "o8_dispatch" => format!("Dispatch the {} orchestrator to: {}", s("repo"), s("task")),
        // Show the real target path — approving a write without seeing where
        // it lands defeats the point of the card.
        "fs_write_text" => format!("Write a file to {}", s("path")),
        "mac_shortcuts_run" => format!("Run the Shortcut “{}”", s("name")),
        other => format!("Run {other}"),
    }
}

/// Spoken phrasing for the confirm gate — the proposal Symon says ALOUD just
/// before the dock card appears. In a hands-free voice flow this lets the user
/// catch a misheard repo/title by ear; the card stays the binding gate (voice
/// can mishear "yes"). Reuses `confirm_summary`, lowercasing the lead verb so it
/// reads naturally after "I'm about to".
fn confirm_spoken(tool_name: &str, args: &Value) -> String {
    let summary = confirm_summary(tool_name, args);
    let mut chars = summary.chars();
    let lowered = match chars.next() {
        Some(first) => first.to_lowercase().collect::<String>() + chars.as_str(),
        None => summary,
    };
    format!("I'm about to {lowered}. Say yes, or cancel.")
}

/// Speak a brief "working on it" filler before the FIRST read tool of a task
/// runs — so a slow lookup (especially the Brain's heavy-synthesis path) doesn't
/// leave dead air before Symon answers. Fires once per task (flips `*spoke`) and
/// is skipped for confirm-gated tools, which already spoke their proposal aloud.
/// Fire-and-forget; it plays while the tool executes.
pub fn maybe_speak_filler(spoke: &mut bool, tool_name: &str) {
    if *spoke {
        return;
    }
    let class = safety::tool_safety_class(tool_name);
    if safety::requires_confirmation(class, safety::reversible_silent_consent()) {
        return;
    }
    *spoke = true;
    crate::tts::playback::play_thread("Let me check.".to_string(), crate::tts::load_config());
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

    // A new task retires any pointers still on screen — they describe a
    // moment that has passed.
    crate::point_overlay::hide_now(&app);

    store::insert_task(&task_id, &prompt);
    emit_agent_event(
        &app,
        json!({ "taskId": task_id, "kind": "status", "status": "running", "intent": prompt }),
    );
    crate::sound::play_sound("Pop");

    // Intent-gated screen context (dossier #2): only prompts that talk ABOUT
    // the screen pay the ~0.5s capture + image tokens. Runs after the
    // "running" emit so the dock's working capsule covers the capture beat.
    let screen_ctx = if screen::wants_screen(&prompt) {
        screen::capture(&app).map(std::sync::Arc::new)
    } else {
        None
    };
    let ctx = TaskCtx { task_id: task_id.clone(), app: app.clone(), screen: screen_ctx };

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
            // Strip [POINT:...] tags BEFORE anything user-facing — the clean
            // text is what gets stored, displayed, and spoken; the tags drive
            // the Symon Points overlay (dossier #1).
            let (clean_text, point_tags) = crate::point_overlay::parse_point_tags(&result.result_text);
            #[cfg(target_os = "macos")]
            if !point_tags.is_empty() {
                if let Some(screen) = &ctx.screen {
                    crate::point_overlay::show_points(&app, screen, &point_tags);
                } else {
                    log::warn!("[symon-agent] model emitted POINT tags without screen context — ignored");
                }
            }
            #[cfg(not(target_os = "macos"))]
            let _ = point_tags;

            store::finish_task(
                &task_id,
                "done",
                &clean_text,
                &result.model_used,
                &result.tool_calls_json,
            );
            emit_agent_event(
                &app,
                json!({ "taskId": task_id, "kind": "status", "status": "done", "result": clean_text }),
            );
            if !clean_text.trim().is_empty() {
                crate::tts::playback::play_thread(clean_text.clone(), crate::tts::load_config());
            }
            notify_done(&app, &clean_text);
            Ok(clean_text)
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

/// Native completion notification — posted via tauri-plugin-notification so it
/// carries the app icon (the Symon/o8 brand) instead of osascript's generic
/// Script Editor icon.
fn notify_done(app: &tauri::AppHandle, result: &str) {
    use tauri_plugin_notification::NotificationExt;
    let body: String = result.chars().take(160).collect();
    let _ = app.notification().builder().title("Symon").body(&body).show();
}
