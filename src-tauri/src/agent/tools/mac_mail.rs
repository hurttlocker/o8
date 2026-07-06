//! Mail tools — search (ReadOnly) / read (ReadOnly) / draft (Reversible) /
//! send_draft (Destructive). AppleScript via osascript. Ported from aqua/Symon
//! to o8's `Result<Value, String>` + shared `as_escape`/`run_applescript`.
//!
//! `read` uses an explicit length clamp instead of aqua's `min(300, …)` —
//! `min` is not a standard AppleScript primitive (matches the fix in mac_notes).

use super::{as_escape, run_applescript};
use serde_json::{json, Value};

pub async fn search(args: Value) -> Result<Value, String> {
    let query = args.get("query").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if query.is_empty() {
        return Err("query is required".into());
    }
    let mailbox = args
        .get("mailbox")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("INBOX")
        .to_string();
    let limit = args.get("limit").and_then(|v| v.as_i64()).unwrap_or(10).max(1);
    let query = as_escape(&query);
    let mailbox = as_escape(&mailbox);

    let script = format!(
        r#"
tell application "Mail"
    set output to ""
    set mb to mailbox "{mailbox}" of account 1
    set msgs to (messages of mb whose subject contains "{query}" or content contains "{query}")
    set counter to 0
    repeat with m in msgs
        if counter >= {limit} then exit repeat
        set output to output & subject of m & "|||" & sender of m & "|||" & (date received of m as string) & "~"
        set counter to counter + 1
    end repeat
    output
end tell
"#
    );

    let raw = tokio::task::spawn_blocking(move || run_applescript(&script))
        .await
        .map_err(|e| format!("spawn_blocking error: {e}"))??;

    Ok(json!({ "messages": parse_messages(&raw, "date") }))
}

pub async fn read(args: Value) -> Result<Value, String> {
    let mailbox = args
        .get("mailbox")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("INBOX")
        .to_string();
    let unread_only = args.get("unread_only").and_then(|v| v.as_bool()).unwrap_or(true);
    let limit = args.get("limit").and_then(|v| v.as_i64()).unwrap_or(5).max(1);
    let mailbox = as_escape(&mailbox);
    let read_filter = if unread_only { "whose read status is false" } else { "" };

    let script = format!(
        r#"
tell application "Mail"
    set output to ""
    set mb to mailbox "{mailbox}" of account 1
    set msgs to (messages of mb {read_filter})
    set counter to 0
    repeat with m in msgs
        if counter >= {limit} then exit repeat
        set contentText to content of m
        set previewLen to count of characters of contentText
        if previewLen > 300 then set previewLen to 300
        set preview to ""
        if previewLen > 0 then set preview to (text 1 thru previewLen of contentText)
        set output to output & subject of m & "|||" & sender of m & "|||" & preview & "~"
        set counter to counter + 1
    end repeat
    output
end tell
"#
    );

    let raw = tokio::task::spawn_blocking(move || run_applescript(&script))
        .await
        .map_err(|e| format!("spawn_blocking error: {e}"))??;

    Ok(json!({ "messages": parse_messages(&raw, "body_preview") }))
}

pub async fn draft(args: Value) -> Result<Value, String> {
    let to = args.get("to").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let subject = args.get("subject").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if to.is_empty() || subject.is_empty() {
        return Err("to and subject are required".into());
    }
    let body = args.get("body").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let to_esc = as_escape(&to);
    let subject_esc = as_escape(&subject);
    let body_esc = as_escape(&body);

    // visible:true + activate so the operator SEES the composed email on screen
    // (full to/subject/body, editable, ready to send) instead of a silent Drafts
    // entry they have to go hunting for. `save` still persists it to Drafts.
    let script = format!(
        r#"
tell application "Mail"
    activate
    set newMessage to make new outgoing message with properties {{subject:"{subject_esc}", content:"{body_esc}", visible:true}}
    tell newMessage
        make new to recipient at end of to recipients with properties {{address:"{to_esc}"}}
    end tell
    save newMessage
    "draft saved"
end tell
"#
    );

    tokio::task::spawn_blocking(move || run_applescript(&script))
        .await
        .map_err(|e| format!("spawn_blocking error: {e}"))??;

    Ok(json!({ "success": true, "to": to, "subject": subject }))
}

pub async fn send_draft(args: Value) -> Result<Value, String> {
    let subject = args.get("subject").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if subject.is_empty() {
        return Err("subject is required".into());
    }
    let subject_esc = as_escape(&subject);

    let script = format!(
        r#"
tell application "Mail"
    set drafts to messages of mailbox "Drafts" of account 1 whose subject is "{subject_esc}"
    if (count of drafts) = 0 then error "No draft found with subject: {subject_esc}"
    send (item 1 of drafts)
    "sent"
end tell
"#
    );

    tokio::task::spawn_blocking(move || run_applescript(&script))
        .await
        .map_err(|e| format!("spawn_blocking error: {e}"))??;

    Ok(json!({ "success": true, "subject": subject }))
}

/// Parse the `subject|||from|||third~…` osascript output into message objects.
/// `third_key` names the third field (`date` for search, `body_preview` for read).
fn parse_messages(raw: &str, third_key: &str) -> Vec<Value> {
    raw.split('~')
        .filter(|s| !s.trim().is_empty())
        .filter_map(|entry| {
            let parts: Vec<&str> = entry.splitn(3, "|||").collect();
            if parts.len() < 3 {
                return None;
            }
            Some(json!({
                "subject": parts[0].trim(),
                "from": parts[1].trim(),
                third_key: parts[2].trim(),
            }))
        })
        .collect()
}
