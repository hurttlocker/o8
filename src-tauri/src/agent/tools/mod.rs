//! Symon voice-agent Tier-1 tools — native macOS actions via osascript (JXA +
//! AppleScript) and `open`. Lifted from aqua, de-Symonized, trimmed to the V1
//! starter set (open_app, Reminders, Calendar list/create, Notes search/create).
//!
//! SafetyClass is NOT declared on the tool — it's looked up by name from
//! `super::safety`. `enabled_tools()` withholds Destructive tools from the
//! schema the model sees; the loop still gates Reversible tools on a confirm
//! card via `super::confirm_if_needed`.

pub mod apps;
pub mod mac_calendar;
pub mod mac_notes;
pub mod mac_reminders;

use super::{safety, TaskCtx};
use chrono::{Datelike, Timelike};
use serde_json::{json, Value};

/// All tool schemas, in the `{name, description, parameters}` shape (which wraps
/// directly into OpenAI's `function` object).
pub fn all_tools() -> Vec<Value> {
    vec![
        json!({
            "name": "open_app",
            "description": "Open (launch and bring to the front) a macOS application by name — e.g. Reminders, Calendar, Notes, Safari. Use when the user asks to open, show, or pull up an app, including right after creating something in that app.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "Application name, e.g. 'Reminders' or 'Calendar'." }
                },
                "required": ["name"]
            }
        }),
        json!({
            "name": "mac_reminders_list",
            "description": "List the user's reminders. Optionally filter by list name and whether to include completed reminders.",
            "parameters": {
                "type": "object",
                "properties": {
                    "list_name": { "type": "string", "description": "Reminders list to read from. Omit for all lists." },
                    "include_completed": { "type": "boolean", "description": "Include completed reminders. Default false." }
                },
                "required": []
            }
        }),
        json!({
            "name": "mac_reminders_create",
            "description": "Create a reminder. Use an ISO 8601 due_date (e.g. 2026-06-09T15:00:00) when the user gives a time.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": "The reminder text." },
                    "due_date": { "type": "string", "description": "ISO 8601 due date/time. Omit if none given." },
                    "notes": { "type": "string", "description": "Optional notes/body." },
                    "list_name": { "type": "string", "description": "Reminders list. Default 'Reminders'." }
                },
                "required": ["title"]
            }
        }),
        json!({
            "name": "mac_reminders_complete",
            "description": "Mark a reminder complete by its title.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": "The reminder title to complete." },
                    "list_name": { "type": "string", "description": "Reminders list to search. Omit for all." }
                },
                "required": ["title"]
            }
        }),
        json!({
            "name": "mac_calendar_list_events",
            "description": "List upcoming calendar events within the next N days.",
            "parameters": {
                "type": "object",
                "properties": {
                    "days_ahead": { "type": "integer", "description": "How many days ahead to look. Default 7." },
                    "calendar_name": { "type": "string", "description": "Limit to one calendar. Omit for all." }
                },
                "required": []
            }
        }),
        json!({
            "name": "mac_calendar_create_event",
            "description": "Create a calendar event. start_date and end_date are ISO 8601 (e.g. 2026-06-09T15:00:00).",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": "Event title." },
                    "start_date": { "type": "string", "description": "ISO 8601 start." },
                    "end_date": { "type": "string", "description": "ISO 8601 end." },
                    "notes": { "type": "string", "description": "Optional notes." },
                    "calendar_name": { "type": "string", "description": "Target calendar. Omit for the first writable one." }
                },
                "required": ["title", "start_date", "end_date"]
            }
        }),
        json!({
            "name": "mac_notes_search",
            "description": "Search Apple Notes by title or body text.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Text to search for." },
                    "limit": { "type": "integer", "description": "Max notes to return. Default 5." }
                },
                "required": ["query"]
            }
        }),
        json!({
            "name": "mac_notes_create",
            "description": "Create a new Apple Note.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": "Note title." },
                    "body": { "type": "string", "description": "Note body text." },
                    "folder": { "type": "string", "description": "Target folder. Omit for the default." }
                },
                "required": ["title"]
            }
        }),
    ]
}

/// Tools the model is allowed to see — Destructive ones are withheld entirely.
pub fn enabled_tools() -> Vec<Value> {
    all_tools()
        .into_iter()
        .filter(|tool| {
            let Some(name) = tool.get("name").and_then(|n| n.as_str()) else {
                return false;
            };
            safety::tool_safety_class(name) != safety::SafetyClass::Destructive
        })
        .collect()
}

/// Dispatch a parsed tool call to its handler. `args` is already JSON-decoded.
pub async fn dispatch_tool_call(name: &str, args: Value, _ctx: &TaskCtx) -> Result<Value, String> {
    // Hard refuse list (defense in depth — the V1 schema exposes none of these).
    if safety::is_never_do_tool(name) {
        return Err(format!("Tool '{name}' is on the never-do list"));
    }
    if let Some(path) = args.get("path").and_then(|p| p.as_str()) {
        if safety::is_never_do_path(path) {
            return Err(format!("Path '{path}' is a protected system path"));
        }
    }

    match name {
        "open_app" => apps::open_app(args).await,
        "mac_reminders_list" => mac_reminders::list(args).await,
        "mac_reminders_create" => mac_reminders::create(args).await,
        "mac_reminders_complete" => mac_reminders::complete(args).await,
        "mac_calendar_list_events" => mac_calendar::list_events(args).await,
        "mac_calendar_create_event" => mac_calendar::create_event(args).await,
        "mac_notes_search" => mac_notes::search(args).await,
        "mac_notes_create" => mac_notes::create(args).await,
        other => Err(format!("Unknown tool: {other}")),
    }
}

// ── osascript executors ──────────────────────────────────────────────────────

/// Run a JXA (JavaScript-for-Automation) script, returning stdout.
pub(crate) fn run_osascript_jxa(script: &str) -> Result<String, String> {
    let output = std::process::Command::new("osascript")
        .args(["-l", "JavaScript", "-e", script])
        .output()
        .map_err(|e| format!("osascript exec failed: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(format!(
            "osascript error: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

/// Run an AppleScript, returning stdout.
pub(crate) fn run_applescript(script: &str) -> Result<String, String> {
    let output = std::process::Command::new("osascript")
        .args(["-e", script])
        .output()
        .map_err(|e| format!("AppleScript exec failed: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(format!(
            "AppleScript error: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

// ── shared helpers ───────────────────────────────────────────────────────────

/// Escape a string for embedding inside an AppleScript double-quoted literal.
pub(crate) fn as_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n")
}

/// Parse a model-emitted ISO 8601 date/time into (year, month, day, hour, min).
/// Date-only strings default to 9:00 AM. Returns None if unparseable.
pub(crate) fn parse_due_components(s: &str) -> Option<(i32, u32, u32, u32, u32)> {
    use chrono::{DateTime, NaiveDate, NaiveDateTime};
    let s = s.trim();
    if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
        let n = dt.naive_local();
        return Some((n.year(), n.month(), n.day(), n.hour(), n.minute()));
    }
    for fmt in [
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%dT%H:%M",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
    ] {
        if let Ok(n) = NaiveDateTime::parse_from_str(s, fmt) {
            return Some((n.year(), n.month(), n.day(), n.hour(), n.minute()));
        }
    }
    if let Ok(d) = NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        return Some((d.year(), d.month(), d.day(), 9, 0));
    }
    None
}

/// Build an AppleScript block that sets `var` to a date with the given
/// components. Day is set to 1 first to avoid month-overflow when reassigning.
pub(crate) fn date_setter_block(var: &str, (y, mo, d, h, mi): (i32, u32, u32, u32, u32)) -> String {
    format!(
        "set {var} to (current date)\n\
         set day of {var} to 1\n\
         set year of {var} to {y}\n\
         set month of {var} to {mo}\n\
         set day of {var} to {d}\n\
         set hours of {var} to {h}\n\
         set minutes of {var} to {mi}\n\
         set seconds of {var} to 0\n"
    )
}
