//! In-place text editing — the selection-as-object lane (magic roadmap #1).
//!
//! Hold Option and say "make this more professional": the spoken sentence is
//! the verb, the text under the user is the noun. The noun is the SELECTION
//! when one exists, otherwise the FOCUSED TEXT FIELD (the "email is just
//! open" case). The replacement happens IN PLACE on screen — no confirm card.
//! Governance is undo-after instead of confirm-before: the pre-state is held
//! here and surfaced as a one-tap Revert chip in the dock (operator-locked
//! 2026-06-10). A frontmost-app guard refuses the write if focus moved
//! between capture and apply.

use serde_json::json;
use std::sync::Mutex;
use tauri::Emitter;

pub enum EditMode {
    Selection,
    Field,
}

pub struct EditContext {
    pub mode: EditMode,
    /// The text being transformed (selection, or the whole field value).
    pub original: String,
    /// Full field value when readable — the preferred revert anchor (whole-
    /// field restore works even for the selection case, since the user hasn't
    /// typed between apply and revert).
    pub field_value: Option<String>,
    pub field_settable: bool,
    /// Exact AX field captured with the noun. Revert uses this identity and the
    /// post-edit value, never whichever field is focused after clicking the dock.
    pub field_target: Option<crate::paste::FocusedField>,
    /// Frontmost bundle id at capture time.
    pub app: String,
    /// True when the noun lives inside o8's OWN webview: a WKWebView exposes
    /// neither `AXSelectedText` nor a reliable synthetic Cmd+C (same wall the
    /// Ctrl+Shift+S speak-selection path hit), so capture/apply/revert round-trip
    /// through the main webview's DOM instead of the AX/paste path.
    pub via_webview: bool,
}

/// Conservative cue list — every entry implies "transform the text I'm
/// touching". Generic verbs like "change" or "write" are deliberately absent
/// (they belong to drafting/tool lanes, not the edit lane).
const EDIT_CUES: &[&str] = &[
    "rewrite",
    "re-write",
    "reword",
    "rephrase",
    "professional",
    "more formal",
    "less formal",
    "friendlier",
    "more casual",
    "more polite",
    "shorter",
    "more concise",
    "tighten this",
    "tighten it",
    "tighten that",
    "polish this",
    "polish it",
    "polish that",
    "tune this up",
    "tune it up",
    "tune that up",
    "improve this writing",
    "improve this message",
    "proofread",
    "fix the grammar",
    "fix grammar",
    "fix my grammar",
    "fix the spelling",
    "fix spelling",
    "fix my spelling",
    "spell check",
    "spellcheck",
    "make this sound",
    "make it sound",
    "make that sound",
    "change the tone",
    "soften this",
    "soften it",
    "punchier",
    "clean this up",
    "clean it up",
    "clean that up",
    "simplify this",
    "simplify it",
    "make this clearer",
    "make it clearer",
    "translate this",
    "translate it",
];

pub fn wants_edit(prompt: &str) -> bool {
    let p = prompt.to_lowercase();
    EDIT_CUES.iter().any(|cue| p.contains(cue))
}

/// Capture the editable noun: selection first (the pointed case), else the
/// focused text field (the open-email case). None when nothing editable is
/// under the user — the prompt then carries an honesty note instead.
///
/// When o8 itself is frontmost the AX path is blind (WKWebView), so the
/// capture round-trips through the main webview's DOM instead.
pub fn capture(app_handle: &tauri::AppHandle) -> Option<EditContext> {
    if crate::paste::frontmost_is_o8() {
        return capture_from_webview(app_handle);
    }
    let app = crate::paste::current_frontmost_bundle_id().unwrap_or_default();
    let selection = crate::paste::read_selected_text_via_accessibility();
    let field = crate::paste::read_focused_field();
    match selection {
        Some(sel) if !sel.trim().is_empty() => Some(EditContext {
            mode: EditMode::Selection,
            original: crate::utf8_head(&sel, 12 * 1024).to_string(),
            field_value: field.as_ref().map(|f| f.value.clone()),
            field_settable: field.as_ref().map(|f| f.settable).unwrap_or(false),
            field_target: field,
            app,
            via_webview: false,
        }),
        _ => field.map(|f| {
            let value = f.value.clone();
            EditContext {
                mode: EditMode::Field,
                original: value.clone(),
                field_value: Some(value),
                field_settable: f.settable,
                field_target: Some(f),
                app,
                via_webview: false,
            }
        }),
    }
}

// ── o8-webview round-trip ────────────────────────────────────────────────────
// Request/response over Tauri events: Rust emits `o8:edit-capture` /
// `o8:edit-apply` to the MAIN webview; the DictationHost listener does the DOM
// work (window.getSelection, React-safe value setters, execCommand insertText
// for contenteditable/CodeMirror) and answers via the `agent_edit_capture_result`
// / `agent_edit_apply_result` commands. Same blocking-channel shape as the
// confirm gate; ~700ms timeout means a busy/hydrating webview degrades to the
// honesty note, never a hang.

/// Webview's answer to a capture request.
#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WebviewEditState {
    pub selection: Option<String>,
    pub field_value: Option<String>,
    #[serde(default)]
    pub field_editable: bool,
}

/// Webview's answer to an apply request.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebviewApplyResult {
    #[serde(default)]
    pub ok: bool,
    pub error: Option<String>,
}

enum WebviewReply {
    Capture(WebviewEditState),
    Apply(WebviewApplyResult),
}

static WEBVIEW_CHANNELS: Mutex<Vec<(String, std::sync::mpsc::Sender<WebviewReply>)>> =
    Mutex::new(Vec::new());

fn webview_request(
    app_handle: &tauri::AppHandle,
    event: &str,
    payload: serde_json::Value,
) -> Option<WebviewReply> {
    let request_id = format!(
        "ed-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    let (tx, rx) = std::sync::mpsc::channel();
    {
        let mut chans = WEBVIEW_CHANNELS.lock().unwrap_or_else(|p| p.into_inner());
        chans.push((request_id.clone(), tx));
    }
    let mut payload = payload;
    payload["requestId"] = json!(request_id);
    let _ = app_handle.emit_to("main", event, payload);
    let reply = rx.recv_timeout(std::time::Duration::from_millis(700)).ok();
    {
        let mut chans = WEBVIEW_CHANNELS.lock().unwrap_or_else(|p| p.into_inner());
        chans.retain(|(id, _)| id != &request_id);
    }
    reply
}

/// Resolve a pending webview request — called by the `agent_edit_*_result`
/// commands (sync senders, no async context needed).
fn resolve_webview(request_id: &str, reply: WebviewReply) {
    let sender = {
        let mut chans = WEBVIEW_CHANNELS.lock().unwrap_or_else(|p| p.into_inner());
        chans
            .iter()
            .position(|(id, _)| id == request_id)
            .map(|pos| chans.remove(pos).1)
    };
    if let Some(tx) = sender {
        let _ = tx.send(reply);
    }
}

pub fn resolve_webview_capture(request_id: &str, state: WebviewEditState) {
    resolve_webview(request_id, WebviewReply::Capture(state));
}

pub fn resolve_webview_apply(request_id: &str, result: WebviewApplyResult) {
    resolve_webview(request_id, WebviewReply::Apply(result));
}

fn capture_from_webview(app_handle: &tauri::AppHandle) -> Option<EditContext> {
    let reply = webview_request(app_handle, "o8:edit-capture", json!({}))?;
    let WebviewReply::Capture(state) = reply else {
        return None;
    };
    let app = crate::paste::current_frontmost_bundle_id().unwrap_or_default();
    let field_value = state
        .field_value
        .filter(|v| !v.is_empty() && v.len() <= 24 * 1024);
    match state.selection {
        Some(sel) if !sel.trim().is_empty() => Some(EditContext {
            mode: EditMode::Selection,
            original: crate::utf8_head(&sel, 12 * 1024).to_string(),
            field_settable: state.field_editable && field_value.is_some(),
            field_value,
            field_target: None,
            app,
            via_webview: true,
        }),
        _ => {
            let value = field_value.filter(|_| state.field_editable)?;
            Some(EditContext {
                mode: EditMode::Field,
                original: crate::utf8_head(&value, 12 * 1024).to_string(),
                field_value: Some(value),
                field_settable: true,
                field_target: None,
                app,
                via_webview: true,
            })
        }
    }
}

/// Apply (or revert) text inside o8's webview. `mode` is "selection" or
/// "field" — the listener replaces the live selection or the whole focused
/// editable respectively.
fn apply_via_webview(
    app_handle: &tauri::AppHandle,
    mode: &str,
    text: &str,
) -> Result<(), String> {
    let reply = webview_request(
        app_handle,
        "o8:edit-apply",
        json!({ "mode": mode, "text": text }),
    );
    match reply {
        Some(WebviewReply::Apply(r)) if r.ok => Ok(()),
        Some(WebviewReply::Apply(r)) => Err(r
            .error
            .unwrap_or_else(|| "the o8 window couldn't apply the edit".to_string())),
        _ => Err("the o8 window didn't answer the edit request".to_string()),
    }
}

// ── revert buffer ────────────────────────────────────────────────────────────

enum Restore {
    /// Whole-field restore anchored to the exact field and post-edit value.
    FieldValue {
        value: String,
        expected_value: String,
        target: crate::paste::FocusedField,
    },
    /// Whole-field restore through the o8 webview (the WKWebView lane).
    WebviewField { value: String },
    /// Last resort: put the original on the clipboard for a manual paste.
    Clipboard { original: String },
}

struct AppliedEdit {
    restore: Restore,
    app: String,
}

static LAST_EDIT: Mutex<Option<AppliedEdit>> = Mutex::new(None);

/// Friendly app name from a bundle id ("com.apple.mail" → "Mail").
fn friendly_app(bundle_id: &str) -> String {
    if bundle_id.contains("o8") {
        return "o8".to_string();
    }
    let last = bundle_id.rsplit('.').next().unwrap_or(bundle_id);
    let mut chars = last.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => last.to_string(),
    }
}

/// Observe the full post-edit field value after a selection paste. Synthetic
/// Cmd+V is delivered asynchronously in some apps, especially on Intel, so the
/// revert anchor waits briefly instead of guessing how the selected slice was
/// normalized inside the field.
fn observe_applied_field_value(
    target: &crate::paste::FocusedField,
    previous_value: &str,
) -> Option<String> {
    let deadline =
        std::time::Instant::now() + std::time::Duration::from_millis(700);
    while std::time::Instant::now() < deadline {
        if let Some(current) = crate::paste::read_focused_field() {
            if crate::paste::same_focused_field(target, &current)
                && current.value != previous_value
            {
                return Some(current.value);
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    None
}

fn copy_restore_fallback(value: &str) {
    let _ = crate::paste::copy_to_clipboard(value);
    crate::tts::playback::play_thread(
        "I couldn't restore it in place — the original is on your clipboard.".to_string(),
        crate::tts::load_config(),
    );
}

/// Apply the replacement in place. Selection mode pastes over the live
/// selection; field mode sets AXValue (or select-all + paste when the element
/// refuses the AX write). Stashes the pre-state for `revert` and emits the
/// dock Revert chip.
pub fn apply(
    app_handle: &tauri::AppHandle,
    ctx: &EditContext,
    new_text: &str,
) -> Result<serde_json::Value, String> {
    let new_text = new_text.trim_end();
    if new_text.trim().is_empty() {
        return Err("apply_text_edit needs a non-empty new_text".into());
    }

    // Focus guard: a capture from 3 seconds ago must never write into a
    // window the user has since switched to.
    if !ctx.app.is_empty() {
        if let Some(front) = crate::paste::current_frontmost_bundle_id() {
            if front != ctx.app {
                return Err(format!(
                    "The focused app changed ({} → {}) — didn't apply. Ask the user to click back into the text and try again.",
                    friendly_app(&ctx.app),
                    friendly_app(&front)
                ));
            }
        }
    }

    if ctx.via_webview {
        let mode = match ctx.mode {
            EditMode::Selection => "selection",
            EditMode::Field => "field",
        };
        apply_via_webview(app_handle, mode, new_text)?;
    } else {
        match ctx.mode {
            EditMode::Selection => {
                // paste_text replaces the live selection at the caret (and handles
                // clipboard save/restore + focus settle internally).
                crate::paste::paste_text(new_text);
            }
            EditMode::Field => {
                if !(ctx.field_settable && crate::paste::write_focused_field_value(new_text)) {
                    crate::paste::select_all_in_focused();
                    std::thread::sleep(std::time::Duration::from_millis(120));
                    crate::paste::paste_text(new_text);
                }
            }
        }
    }

    let observed_field_value = match (&ctx.field_target, &ctx.field_value) {
        (Some(target), Some(previous)) => {
            let observed = observe_applied_field_value(target, previous);
            match ctx.mode {
                EditMode::Field => observed.or_else(|| Some(new_text.to_string())),
                EditMode::Selection => observed,
            }
        }
        _ => None,
    };
    let restore = match (
        &ctx.field_value,
        &ctx.field_target,
        observed_field_value,
    ) {
        (Some(value), _, _) if ctx.via_webview => {
            Restore::WebviewField { value: value.clone() }
        }
        (Some(value), Some(target), Some(expected_value)) => Restore::FieldValue {
            value: value.clone(),
            expected_value,
            target: target.clone(),
        },
        _ => Restore::Clipboard {
            original: ctx.original.clone(),
        },
    };
    {
        let mut slot = LAST_EDIT.lock().unwrap_or_else(|p| p.into_inner());
        *slot = Some(AppliedEdit { restore, app: ctx.app.clone() });
    }

    let app_name = friendly_app(&ctx.app);
    let payload = json!({ "app": app_name });
    let _ = app_handle.emit_to(crate::dock_window::DOCK_LABEL, "o8:edit-applied", payload.clone());
    let _ = app_handle.emit("o8:edit-applied", payload);
    log::info!("[symon-edit] applied {} chars in {app_name}", new_text.len());

    Ok(json!({ "applied": true, "app": app_name }))
}

/// One-tap revert from the dock chip. Whole-field restore when we hold the
/// pre-edit field value; otherwise the original lands on the clipboard and
/// Symon says so (honest fallback — never pretend a restore we can't make).
pub fn revert(app_handle: &tauri::AppHandle) -> Result<(), String> {
    let edit = {
        let mut slot = LAST_EDIT.lock().unwrap_or_else(|p| p.into_inner());
        slot.take()
    };
    let Some(edit) = edit else {
        return Err("Nothing to revert".into());
    };

    match edit.restore {
        Restore::FieldValue {
            value,
            expected_value,
            target,
        } => {
            let activated = crate::paste::activate_app_target(&edit.app, target.process_id);
            let restored = activated
                && (crate::paste::write_focused_field_value_if_matches(
                    &target,
                    &expected_value,
                    &value,
                ) || {
                    // Some text surfaces expose AXValue for reads but refuse
                    // writes. Verify the exact target again, then use a direct
                    // paste that cannot reactivate PREVIOUS_APP.
                    if !crate::paste::focused_field_matches(&target, &expected_value) {
                        false
                    } else {
                        crate::paste::select_all_in_focused();
                        std::thread::sleep(std::time::Duration::from_millis(120));
                        crate::paste::focused_field_matches(&target, &expected_value)
                            && crate::paste::paste_text_in_current_field(&value).did_paste()
                    }
                });
            if restored {
                log::info!("[symon-edit] reverted in {}", friendly_app(&edit.app));
            } else {
                copy_restore_fallback(&value);
                log::warn!(
                    "[symon-edit] target changed or restore failed in {}; original copied",
                    friendly_app(&edit.app)
                );
            }
        }
        Restore::WebviewField { value } => {
            if let Err(e) = apply_via_webview(app_handle, "field", &value) {
                copy_restore_fallback(&value);
                log::warn!("[symon-edit] webview revert failed ({e}); fell back to clipboard");
            } else {
                log::info!("[symon-edit] reverted in o8");
            }
        }
        Restore::Clipboard { original } => {
            copy_restore_fallback(&original);
            log::info!("[symon-edit] revert fell back to clipboard");
        }
    }
    Ok(())
}

#[cfg(test)]
mod wants_edit_tests {
    use super::wants_edit;

    #[test]
    fn edit_verbs_trigger() {
        assert!(wants_edit("Can you rewrite this in a more professional way?"));
        assert!(wants_edit("fix the grammar here"));
        assert!(wants_edit("make this sound friendlier"));
        assert!(wants_edit("tighten this up please"));
    }

    #[test]
    fn non_edit_prompts_do_not() {
        assert!(!wants_edit("Remind me to call Q at 3pm"));
        assert!(!wants_edit("What's shipping in o8?"));
        assert!(!wants_edit("Draft an email to Sydney about the launch"));
    }
}
