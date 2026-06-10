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
    /// Frontmost bundle id at capture time.
    pub app: String,
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
pub fn capture() -> Option<EditContext> {
    let app = crate::paste::current_frontmost_bundle_id().unwrap_or_default();
    let selection = crate::paste::read_selected_text_via_accessibility();
    let field = crate::paste::read_focused_field();
    match selection {
        Some(sel) if !sel.trim().is_empty() => Some(EditContext {
            mode: EditMode::Selection,
            original: crate::utf8_head(&sel, 12 * 1024).to_string(),
            field_value: field.as_ref().map(|f| f.value.clone()),
            field_settable: field.as_ref().map(|f| f.settable).unwrap_or(false),
            app,
        }),
        _ => field.map(|f| EditContext {
            mode: EditMode::Field,
            original: f.value.clone(),
            field_value: Some(f.value),
            field_settable: f.settable,
            app,
        }),
    }
}

// ── revert buffer ────────────────────────────────────────────────────────────

enum Restore {
    /// Whole-field restore — clean and exact while the user hasn't typed.
    FieldValue { value: String, settable: bool },
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
    let last = bundle_id.rsplit('.').next().unwrap_or(bundle_id);
    let mut chars = last.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => last.to_string(),
    }
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

    let restore = match &ctx.field_value {
        Some(v) => Restore::FieldValue { value: v.clone(), settable: ctx.field_settable },
        None => Restore::Clipboard { original: ctx.original.clone() },
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
        Restore::FieldValue { value, settable } => {
            if !(settable && crate::paste::write_focused_field_value(&value)) {
                crate::paste::select_all_in_focused();
                std::thread::sleep(std::time::Duration::from_millis(120));
                crate::paste::paste_text(&value);
            }
            log::info!("[symon-edit] reverted in {}", friendly_app(&edit.app));
        }
        Restore::Clipboard { original } => {
            let _ = crate::paste::copy_to_clipboard(&original);
            crate::tts::playback::play_thread(
                "I couldn't restore it in place — the original is on your clipboard.".to_string(),
                crate::tts::load_config(),
            );
            log::info!("[symon-edit] revert fell back to clipboard");
        }
    }
    let _ = app_handle;
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
