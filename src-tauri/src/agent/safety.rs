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
        // Apps — launching an app has no destructive side effect.
        "open_app" => SafetyClass::ReadOnly,
        // Notes
        "mac_notes_search" => SafetyClass::ReadOnly,
        "mac_notes_create" => SafetyClass::Reversible,
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
