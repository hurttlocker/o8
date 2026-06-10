//! Symon voice-agent safety classification (lifted from aqua, de-Symonized).
//!
//! Every tool is tagged with a `SafetyClass`; the loop gates each call on it.
//! ReadOnly runs immediately, Reversible needs blanket consent (default OFF →
//! confirm card), Destructive ALWAYS needs a per-action confirm card.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SafetyClass {
    /// No side effects — search, list, read, open an app. Always autonomous.
    ReadOnly,
    /// Has side effects but is undoable (create reminder/event/note). Confirm
    /// unless the user has flipped blanket consent.
    Reversible,
    /// Permanent / high-impact (send mail, delete, run Shortcuts). Always
    /// confirm — the consent toggle is ignored.
    Destructive,
}

/// Does this class need a confirm card, given the blanket-consent toggle?
pub fn requires_confirmation(class: SafetyClass, reversible_silent: bool) -> bool {
    match class {
        SafetyClass::ReadOnly => false,
        SafetyClass::Reversible => !reversible_silent,
        SafetyClass::Destructive => true, // non-negotiable
    }
}

/// Tag a tool by name. Unknown tools default to Destructive (safest).
pub fn tool_safety_class(tool_name: &str) -> SafetyClass {
    match tool_name {
        // Calendar
        "mac_calendar_list_events" => SafetyClass::ReadOnly,
        "mac_calendar_create_event" => SafetyClass::Reversible,
        // Reminders
        "mac_reminders_list" => SafetyClass::ReadOnly,
        "mac_reminders_create" => SafetyClass::Reversible,
        "mac_reminders_complete" => SafetyClass::Reversible,
        // Apps — launching/listing apps has no destructive side effect.
        "open_app" => SafetyClass::ReadOnly,
        "list_apps" => SafetyClass::ReadOnly,
        // Notes
        "mac_notes_search" => SafetyClass::ReadOnly,
        "mac_notes_create" => SafetyClass::Reversible,
        "mac_notes_append" => SafetyClass::Reversible,
        // Calendar (delete)
        "mac_calendar_delete_event" => SafetyClass::Destructive,
        // Contacts
        "mac_contacts_search" => SafetyClass::ReadOnly,
        // Mail
        "mac_mail_search" => SafetyClass::ReadOnly,
        "mac_mail_read" => SafetyClass::ReadOnly,
        "mac_mail_draft" => SafetyClass::Reversible,
        "mac_mail_send_draft" => SafetyClass::Destructive,
        // Shortcuts
        "mac_shortcuts_list" => SafetyClass::ReadOnly,
        "mac_shortcuts_run" => SafetyClass::Destructive,
        // Filesystem (writes sandboxed to ~/.o8/agent-output)
        "fs_read_text" => SafetyClass::ReadOnly,
        "fs_write_text" => SafetyClass::Reversible,
        "fs_spotlight" => SafetyClass::ReadOnly,
        // CSV (writes sandboxed to ~/.o8/agent-output)
        "csv_read" => SafetyClass::ReadOnly,
        "csv_write" => SafetyClass::Reversible,
        // In-place text edit — classed ReadOnly DELIBERATELY (operator-locked
        // 2026-06-10): the edit lane holds the pre-state and surfaces a
        // one-tap Revert chip in the dock, so governance is undo-AFTER
        // instead of confirm-before (a card on every rewrite kills the
        // magic). A frontmost-app guard refuses misdirected writes, and the
        // tool only fires when the prompt carried an explicit edit verb.
        "apply_text_edit" => SafetyClass::ReadOnly,
        // o8 bridge (Tier-2). Reads are autonomous. o8_dispatch launches an
        // autonomous coding worker (compute + tokens) → Reversible so it ALWAYS
        // shows the spoken-confirm card in V1 (blanket consent is hardcoded OFF).
        // NOTE: if blanket consent ever ships, exclude o8_dispatch from it — a
        // worker spawn must never go silent.
        "o8_status" => SafetyClass::ReadOnly,
        "o8_needs_me" => SafetyClass::ReadOnly,
        "o8_ask" => SafetyClass::ReadOnly,
        // o8 UI control — showing a surface of o8's own window has no
        // destructive side effect (same reasoning as open_app).
        "o8_ui_open" => SafetyClass::ReadOnly,
        "o8_panel_read" => SafetyClass::ReadOnly,
        // Apple Music — playback control mutates no data and pause undoes it
        // instantly; a confirm card on "play my playlist" kills the magic.
        "mac_music_playlists" => SafetyClass::ReadOnly,
        "mac_music_play" => SafetyClass::ReadOnly,
        "mac_music_pause" => SafetyClass::ReadOnly,
        "mac_music_next" => SafetyClass::ReadOnly,
        "mac_music_now_playing" => SafetyClass::ReadOnly,
        "o8_dispatch" => SafetyClass::Reversible,
        // Approval triage (magic roadmap #2). Semantically these RELEASE a
        // gated action (a merge, a plan, a command) — Destructive in spirit,
        // but Destructive tools are withheld from the model entirely by
        // enabled_tools(), so they're tagged Reversible: with blanket consent
        // hardcoded OFF in V1 every call fires the spoken proposal + dock
        // confirm card. NOTE: if blanket consent ever ships, EXCLUDE these
        // (like o8_dispatch) — releasing an approval must never go silent.
        "o8_approve_item" => SafetyClass::Reversible,
        "o8_reject_item" => SafetyClass::Reversible,
        // GitHub + local git (Tier-3) — all read-only.
        "git_status" => SafetyClass::ReadOnly,
        "git_log" => SafetyClass::ReadOnly,
        "gh_pr_list" => SafetyClass::ReadOnly,
        "gh_issue_list" => SafetyClass::ReadOnly,
        // Unknown — default to destructive.
        _ => SafetyClass::Destructive,
    }
}

/// Blanket consent for Reversible tools. V1: always OFF, so every create asks.
/// A later version can read this from voice prefs.
pub fn reversible_silent_consent() -> bool {
    false
}

/// Tools that are NEVER run, regardless of confirmation (hard refuse).
const NEVER_DO_TOOLS: &[&str] = &[
    "bash", "shell", "exec", "system", "sudo", "modify_keychain", "change_password",
    "modify_sudoers",
];

/// Protected paths the agent will never touch (filesystem tools, future).
const NEVER_DO_PATHS: &[&str] = &[
    "/etc/", "/usr/", "/bin/", "/sbin/", "/var/", "/private/", "/System/",
    "/Library/Keychains/", ".tauri", ".env", "credentials", "secrets",
];

pub fn is_never_do_tool(tool_name: &str) -> bool {
    let lower = tool_name.to_lowercase();
    NEVER_DO_TOOLS.iter().any(|t| lower.contains(t))
}

pub fn is_never_do_path(path: &str) -> bool {
    NEVER_DO_PATHS.iter().any(|p| path.contains(p))
}
