//! Symon voice-agent safety classification (lifted from aqua, de-Symonized).
//!
//! Every tool is tagged with a `SafetyClass`; the loop gates each call on it.
//! ReadOnly runs immediately, Reversible needs blanket consent (default OFF →
//! confirm card), Destructive ALWAYS needs a per-action confirm card.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SafetyClass {
    /// No side effects — search, list, read, open an app. Always autonomous.
    ReadOnly,
    /// Has side effects but remains model-reachable behind a confirmation card.
    /// This is a governance class, not a promise of semantic undo; the action
    /// ledger's `UndoCapability` owns that narrower contract.
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
    "mac_reminders_update" => SafetyClass::Reversible,
    "mac_calendar_update_event" => SafetyClass::Reversible,
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
        // Operator-installed SKILL.md guidance only. Activation is a local,
        // bounded prompt preference and is immediately reversible.
        "symon_skills_list" => SafetyClass::ReadOnly,
        "symon_skill_activate" => SafetyClass::ReadOnly,
        "symon_skill_deactivate" => SafetyClass::ReadOnly,
        // o8 bridge (Tier-2). Reads are autonomous. o8_dispatch launches an
        // autonomous coding worker (compute + tokens) → Reversible so it ALWAYS
        // shows the spoken-confirm card in V1 (blanket consent is hardcoded OFF).
        // NOTE: if blanket consent ever ships, exclude o8_dispatch from it — a
        // worker spawn must never go silent.
        "o8_status" => SafetyClass::ReadOnly,
        "o8_needs_me" => SafetyClass::ReadOnly,
        "o8_ask" => SafetyClass::ReadOnly,
        // o8 team peer messaging — relaying a note to a running agent (same
        // posture as o8_delegate: hands a message to a live agent, no repo
        // mutation, and the recipient's own actions stay gated downstream).
        // Reading the message log is pure observation. Keep the voice flow fluid.
        "o8_team_tell" => SafetyClass::ReadOnly,
        "o8_team_inbox" => SafetyClass::ReadOnly,
        // o8 UI control — showing a surface of o8's own window has no
        // destructive side effect (same reasoning as open_app).
        "o8_ui_open" => SafetyClass::ReadOnly,
        // Flipping a UI preference (theme / surface / canvas mode) is reversible
        // and non-destructive — runs immediately, same as showing a surface.
        "o8_ui_set" => SafetyClass::ReadOnly,
        // Canvas control — only changes what's on the operator's SCREEN, never
        // repo state. `send-prompt` reaches the orchestrator, but that's the
        // same path as typing in the composer, and the orchestrator's own
        // mutations (worker spawn, merge) stay gated downstream by o8's
        // review/approval pipeline — so no extra confirm card here.
        "o8_canvas" => SafetyClass::ReadOnly,
        // Browser driving. Reading the page / waiting for an element is pure
        // observation. Acting (click / type / open) can submit a form on a real
        // logged-in site → Reversible so it ALWAYS cards (same posture as
        // term_send); if blanket consent ever ships, EXCLUDE o8_browser_act.
        "o8_browser_read" => SafetyClass::ReadOnly,
        "o8_browser_act" => SafetyClass::Reversible,
        // Reading a packet's diff + review state is read-through; releasing the
        // merge stays on o8_approve_item (carded there).
        "o8_review_diff" => SafetyClass::ReadOnly,
        // Conductor delegation starts a repo-scoped orchestrator turn. Even
        // though downstream code changes remain governed, starting the turn
        // spends compute and can dispatch work, so the operator confirms the
        // exact repo + task before it leaves Symon.
        "o8_delegate" => SafetyClass::Reversible,
        // Annotating the operator's living spec (o8.md) is a write → cards.
        "o8_spec_annotate" => SafetyClass::Reversible,
        // Reading the screen is pure observation; capture is permission-gated by
        // macOS Screen Recording, so no confirm card.
        "read_screen" => SafetyClass::ReadOnly,
        "o8_panel_read" => SafetyClass::ReadOnly,
        "o8_recap" => SafetyClass::ReadOnly,
        "o8_usage" => SafetyClass::ReadOnly,
        // o8-hosted PTYs only. Listing is observational; writing can execute a
        // shell/agent command, so it uses the same always-carded posture as
        // term_send even though the target is never a foreign terminal app.
        "terminal_list" => SafetyClass::ReadOnly,
        "terminal_send" => SafetyClass::Reversible,
        // Terminal control (dev frontier). Surveying is harmless; term_send
        // EXECUTES a line in a live shell → Reversible so it ALWAYS shows the
        // spoken proposal + confirm card in V1. NOTE: if blanket consent ever
        // ships, EXCLUDE term_send (like o8_dispatch) — a shell exec must
        // never go silent.
        "term_list" => SafetyClass::ReadOnly,
        "term_read" => SafetyClass::ReadOnly,
        // Session watcher (#1653): pure transcript reads, never a confirm card.
        "session_list" => SafetyClass::ReadOnly,
        "session_peek" => SafetyClass::ReadOnly,
        "term_send" => SafetyClass::Reversible,
        "agent_turn" => SafetyClass::Reversible,
        "agent_turn_result" => SafetyClass::ReadOnly,
        "term_interrupt" => SafetyClass::Reversible,
        "term_key" => SafetyClass::Reversible,
        "term_new" => SafetyClass::Reversible,
        // Watching only observes a window the user explicitly named; the
        // one-shot spoken announcement is the entire side effect.
        "term_watch" => SafetyClass::ReadOnly,
        // Killing an agent reaps a live runtime process + archives the lane →
        // Destructive in spirit, but Destructive tools are withheld from the
        // model entirely, so Reversible keeps it reachable by voice and ALWAYS
        // cards in V1 (blanket consent hardcoded OFF). NOTE: if blanket consent
        // ever ships, EXCLUDE o8_stop_agent — a kill must never go silent.
        "o8_stop_agent" => SafetyClass::Reversible,
        // Packet verbs reach a live worker / spawn a fresh one → carded.
        "o8_packet_steer" => SafetyClass::Reversible,
        // Address a working agent by its canvas name and steer it → carded.
        "o8_agent_task" => SafetyClass::Reversible,
        "o8_packet_rerun" => SafetyClass::Reversible,
        // Reset wipes the worktree and archives the lane → carded. (Destructive
        // in spirit, but Destructive tools are withheld from the model entirely,
        // so Reversible keeps it available + always cards in V1.) Wait just polls.
        "o8_packet_reset" => SafetyClass::Reversible,
        "o8_packet_wait" => SafetyClass::ReadOnly,
        // Drafts only — the user presses send, so the draft IS the gate.
        "o8_orchestrator_draft" => SafetyClass::ReadOnly,
        // Writes to the public tracker → carded. GitHub comments can contain
        // arbitrary operator-authored text and retain an individual card even
        // inside an approved plan.
        "gh_issue_create" | "gh_comment" => SafetyClass::Reversible,
        // Day-one assistant basics. Weather only reads public APIs; volume
        // mutates no data and the opposite nudge undoes it instantly (same
        // reasoning as Music playback below).
        "mac_weather" => SafetyClass::ReadOnly,
        "mac_volume" => SafetyClass::ReadOnly,
        // Registers a repo in o8's config → carded like the other o8 writes.
        "o8_add_repo" => SafetyClass::Reversible,
        // Apple Music — playback control mutates no data and pause undoes it
        // instantly; a confirm card on "play my playlist" kills the magic.
        "mac_music_playlists" => SafetyClass::ReadOnly,
        "mac_music_play" => SafetyClass::ReadOnly,
        "mac_music_pause" => SafetyClass::ReadOnly,
        "mac_music_next" => SafetyClass::ReadOnly,
        "mac_music_previous" => SafetyClass::ReadOnly,
        "mac_music_now_playing" => SafetyClass::ReadOnly,
        "o8_dispatch" => SafetyClass::Reversible,
        // Escalation handoff (two-tier brain). The spoken ack is free — ReadOnly
        // so it never cards. The background brain's own tool calls are each gated
        // normally, and the `orchestrator` target re-imposes the o8_dispatch
        // confirm INSIDE the handler so a worker spawn still never goes silent.
        "escalate" => SafetyClass::ReadOnly,
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
        "repo_commit_diff" => SafetyClass::ReadOnly,
        "gh_pr_list" => SafetyClass::ReadOnly,
        "gh_issue_list" => SafetyClass::ReadOnly,
        "gh_issue_view" => SafetyClass::ReadOnly,
        "gh_pr_view" => SafetyClass::ReadOnly,
        "gh_triage" => SafetyClass::ReadOnly,
        // Reading the ledger is observational. Its undo executes a persisted
        // inverse and always receives a fresh confirmation card.
        "symon_ledger_recent" => SafetyClass::ReadOnly,
        "symon_ledger_undo" => SafetyClass::Reversible,
        // The pseudo-tool only proposes a native-validated, immutable plan.
        // Its one card grants exact read-only/reversible steps; destructive
        // steps still receive their own confirmation during execution.
        "symon_execute_plan" => SafetyClass::Reversible,
        // Unknown — default to destructive.
        _ => SafetyClass::Destructive,
    }
}

/// Blanket consent for Reversible tools. V1: always OFF, so every create asks.
/// A later version can read this from voice prefs.
pub fn reversible_silent_consent() -> bool {
    false
}

/// Meta/control tools cannot be smuggled into a plan as ordinary steps. These
/// tools change the active agent, approval, or execution topology itself; they
/// retain their existing one-call governance flow instead.
pub fn is_plan_control_tool(tool_name: &str) -> bool {
    matches!(
        tool_name,
        "symon_execute_plan"
            | "symon_ledger_undo"
            | "escalate"
            | "o8_dispatch"
            | "o8_delegate"
            | "o8_approve_item"
            | "o8_reject_item"
            | "o8_stop_agent"
            | "o8_packet_steer"
            | "o8_agent_task"
            | "o8_packet_rerun"
            | "o8_packet_reset"
            | "o8_packet_wait"
            | "o8_orchestrator_draft"
    )
}

/// Steps whose ordinary policy promises a dedicated card keep that card even
/// after the operator approves the surrounding plan. This is stricter than the
/// broad Reversible class: terminal/browser actions can execute opaque input,
/// while control-plane actions release work or tear down live state.
pub fn requires_individual_plan_confirmation(tool_name: &str) -> bool {
    tool_safety_class(tool_name) == SafetyClass::Destructive
        || is_plan_control_tool(tool_name)
        || matches!(
            tool_name,
            "o8_browser_act"
                | "terminal_send"
                | "term_send"
                | "agent_turn"
                | "term_interrupt"
                | "term_key"
                | "term_new"
                | "gh_issue_create"
                | "gh_comment"
        )
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_control_tools_are_explicit_and_actions_remain_composable() {
        assert!(is_plan_control_tool("symon_execute_plan"));
        assert!(is_plan_control_tool("o8_approve_item"));
        assert!(is_plan_control_tool("o8_packet_reset"));
        assert!(!is_plan_control_tool("mac_reminders_create"));
        assert!(!is_plan_control_tool("mac_shortcuts_run"));
        assert!(requires_individual_plan_confirmation("term_send"));
        assert!(requires_individual_plan_confirmation("agent_turn"));
        assert!(requires_individual_plan_confirmation("terminal_send"));
        assert!(requires_individual_plan_confirmation("o8_browser_act"));
        assert!(requires_individual_plan_confirmation("gh_issue_create"));
        assert!(requires_individual_plan_confirmation("gh_comment"));
        assert!(requires_individual_plan_confirmation("mac_shortcuts_run"));
        assert!(!requires_individual_plan_confirmation("mac_reminders_create"));
    }
}
