//! Calendar tools — list_events (ReadOnly, native EventKit) / create_event +
//! update_event (Reversible, AppleScript). Listing uses the indexed EventKit
//! store (`agent::event_kit`) — the old JXA whose-clause scan took 27s on a
//! real calendar set and the 30s osascript cap killed it. Creation/mutation
//! stay AppleScript because JXA event creation silently fails to persist.
//! delete_event (Destructive) is withheld from the model by `enabled_tools()`
//! until the confirm gate is trusted.

use super::{as_escape, date_setter_block, parse_due_components, run_applescript};
use serde_json::{json, Value};

pub async fn list_events(args: Value) -> Result<Value, String> {
    let days = args.get("days_ahead").and_then(|v| v.as_i64()).unwrap_or(7).clamp(1, 90);
    let calendar_filter = args
        .get("calendar_name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let rows = tokio::task::spawn_blocking(move || {
        crate::agent::event_kit::list_events(days, &calendar_filter)
    })
    .await
    .map_err(|e| format!("spawn_blocking error: {e}"))??;

    let events: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.id,
                "title": r.title,
                "start": r.start_local,
                "end": r.end_local,
                "calendar": r.calendar,
                "all_day": r.all_day,
            })
        })
        .collect();
    Ok(json!({ "events": events }))
}

pub async fn create_event(args: Value) -> Result<Value, String> {
    let title = args.get("title").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let start = args.get("start_date").and_then(|v| v.as_str()).unwrap_or("");
    let end = args.get("end_date").and_then(|v| v.as_str()).unwrap_or("");
    if title.is_empty() {
        return Err("title is required".into());
    }
    let start_comps = parse_due_components(start).ok_or("start_date must be ISO 8601")?;
    let end_comps = parse_due_components(end).ok_or("end_date must be ISO 8601")?;
    let notes = args.get("notes").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let calendar_name = args.get("calendar_name").and_then(|v| v.as_str()).unwrap_or("").to_string();
    // Recurrence — Calendar.app takes a raw RRULE string. Reminders.app's
    // dictionary has no recurrence at all, so repeating asks land HERE (the
    // system prompt routes them).
    let repeat = args.get("repeat").and_then(|v| v.as_str()).unwrap_or("").trim().to_lowercase();
    let rrule = match repeat.as_str() {
        "" | "none" => None,
        "daily" => Some("FREQ=DAILY;INTERVAL=1"),
        "weekdays" => Some("FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR"),
        "weekly" => Some("FREQ=WEEKLY;INTERVAL=1"),
        "biweekly" => Some("FREQ=WEEKLY;INTERVAL=2"),
        "monthly" => Some("FREQ=MONTHLY;INTERVAL=1"),
        "yearly" => Some("FREQ=YEARLY;INTERVAL=1"),
        other => return Err(format!(
            "unknown repeat '{other}' — use daily, weekdays, weekly, biweekly, monthly, or yearly"
        )),
    };

    let start_block = date_setter_block("startDate", start_comps);
    let end_block = date_setter_block("endDate", end_comps);
    let cal_selection = if calendar_name.is_empty() {
        "set targetCal to missing value\n\
         repeat with c in calendars\n\
         \tif writable of c then\n\
         \t\tset targetCal to c\n\
         \t\texit repeat\n\
         \tend if\n\
         end repeat\n\
         if targetCal is missing value then set targetCal to calendar 1\n"
            .to_string()
    } else {
        format!("set targetCal to calendar \"{}\"\n", as_escape(&calendar_name))
    };

    let title_esc = as_escape(&title);
    let notes_esc = as_escape(&notes);
    let recurrence_prop = rrule
        .map(|r| format!(", recurrence:\"{r}\""))
        .unwrap_or_default();
    let script = format!(
        "\ntell application \"Calendar\"\n\
         \tset sep to character id 30\n\
         \t{start_block}\
         \t{end_block}\
         \t{cal_selection}\
         \ttell targetCal\n\
         \t\tset newEvent to make new event with properties {{summary:\"{title_esc}\", start date:startDate, end date:endDate, description:\"{notes_esc}\"{recurrence_prop}}}\n\
         \tend tell\n\
         \tset recurrenceText to \"missing\"\n\
         \tif recurrence of newEvent is not missing value then set recurrenceText to (recurrence of newEvent as string)\n\
         \tset eventFingerprint to (summary of newEvent as string) & sep & (start date of newEvent as string) & sep & (end date of newEvent as string) & sep & (description of newEvent as string) & sep & recurrenceText & sep & (allday event of newEvent as string) & sep & (name of targetCal as string)\n\
         \t(uid of newEvent as string) & sep & eventFingerprint\n\
         end tell"
    );

    let created = tokio::task::spawn_blocking(move || run_applescript(&script))
        .await
        .map_err(|e| format!("spawn_blocking error: {e}"))??;
    let (event_uid, fingerprint) = created
        .split_once('\u{1e}')
        .ok_or_else(|| "Calendar did not return a stable post-create fingerprint".to_string())?;

    let repeats = if repeat.is_empty() { "no".to_string() } else { repeat };
    Ok(json!({
        "success": true,
        "title": title,
        "repeats": repeats,
        "event_uid": event_uid,
        "_ledger_fingerprint": fingerprint,
    }))
}

pub async fn delete_created(event_uid: &str, expected_sha256: &str) -> Result<Value, String> {
    let uid = as_escape(event_uid);
    let expected = as_escape(expected_sha256);
    let script = format!(
        "\ntell application \"Calendar\"\n\
         \tset sep to character id 30\n\
         \tset deletedCount to 0\n\
         \trepeat with c in calendars\n\
         \t\tset matches to events of c whose uid is \"{uid}\"\n\
         \t\trepeat with e in matches\n\
         \t\t\tset recurrenceText to \"missing\"\n\
         \t\t\tif recurrence of e is not missing value then set recurrenceText to (recurrence of e as string)\n\
         \t\t\tset currentFingerprint to (summary of e as string) & sep & (start date of e as string) & sep & (end date of e as string) & sep & (description of e as string) & sep & recurrenceText & sep & (allday event of e as string) & sep & (name of c as string)\n\
         \t\t\tset digestOutput to do shell script \"/usr/bin/printf %s \" & quoted form of currentFingerprint & \" | /usr/bin/shasum -a 256\"\n\
         \t\t\tset currentHash to text 1 thru 64 of digestOutput\n\
         \t\t\tif currentHash is not \"{expected}\" then return \"changed\"\n\
         \t\t\tdelete e\n\
         \t\t\tset deletedCount to deletedCount + 1\n\
         \t\tend repeat\n\
         \tend repeat\n\
         \tdeletedCount as string\n\
         end tell"
    );
    let deleted = tokio::task::spawn_blocking(move || run_applescript(&script))
        .await
        .map_err(|e| format!("spawn_blocking error: {e}"))??;
    match deleted.trim() {
        "1" => Ok(json!({ "undone": true, "event_uid": event_uid })),
        "changed" => Err("Cannot undo because the calendar event changed after Symon created it".into()),
        _ => Err("The created calendar event no longer exists exactly as recorded".into()),
    }
}

/// Update an UPCOMING event in place — move it, rename it, or both. Matches
/// the first future event with the exact summary (the prompt teaches the
/// model to list first). Moving with only `new_start` preserves the event's
/// duration — "push my 2pm to 3" keeps a 30-minute meeting 30 minutes.
pub async fn update_event(args: Value) -> Result<Value, String> {
    let title = args.get("title").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if title.is_empty() {
        return Err("title is required — list the events first to get the exact title".into());
    }
    let new_title = args.get("new_title").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let new_start = args.get("new_start").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let new_end = args.get("new_end").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if new_title.is_empty() && new_start.is_empty() && new_end.is_empty() {
        return Err("nothing to change — give new_start, new_end, or new_title".into());
    }
    let calendar_name = args.get("calendar_name").and_then(|v| v.as_str()).unwrap_or("").to_string();

    let start_block = match (!new_start.is_empty()).then(|| parse_due_components(&new_start)).flatten() {
        Some(comps) => date_setter_block("newStart", comps),
        None if !new_start.is_empty() => return Err("new_start must be ISO 8601".into()),
        None => String::new(),
    };
    let end_block = match (!new_end.is_empty()).then(|| parse_due_components(&new_end)).flatten() {
        Some(comps) => date_setter_block("newEnd", comps),
        None if !new_end.is_empty() => return Err("new_end must be ISO 8601".into()),
        None => String::new(),
    };
    // Apply order matters twice over: capture the old duration BEFORE moving
    // the start, and Calendar validates start<end on EVERY property set — so
    // moving an event LATER than its old end must push the end out first
    // (live-hit -10025 "start date must be before the end date").
    let move_block = match (!new_start.is_empty(), !new_end.is_empty()) {
        (true, true) => "if newStart ≥ (end date of target) then\n\
             \t\tset end date of target to newEnd\n\
             \t\tset start date of target to newStart\n\
             \telse\n\
             \t\tset start date of target to newStart\n\
             \t\tset end date of target to newEnd\n\
             \tend if\n"
            .to_string(),
        (true, false) => "set dur to (end date of target) - (start date of target)\n\
             \tif newStart ≥ (end date of target) then\n\
             \t\tset end date of target to newStart + dur\n\
             \t\tset start date of target to newStart\n\
             \telse\n\
             \t\tset start date of target to newStart\n\
             \t\tset end date of target to newStart + dur\n\
             \tend if\n"
            .to_string(),
        (false, true) => "set end date of target to newEnd\n".to_string(),
        (false, false) => String::new(),
    };
    let rename_line = if new_title.is_empty() {
        String::new()
    } else {
        format!("set summary of target to \"{}\"\n", as_escape(&new_title))
    };

    let title_esc = as_escape(&title);
    let cal_filter = as_escape(&calendar_name);
    let script = format!(
        "\ntell application \"Calendar\"\n\
         \t{start_block}\
         \t{end_block}\
         \tset target to missing value\n\
         \trepeat with c in calendars\n\
         \t\tif \"{cal_filter}\" is \"\" or (name of c) is \"{cal_filter}\" then\n\
         \t\t\ttry\n\
         \t\t\t\tset evs to (events of c whose summary is \"{title_esc}\" and start date ≥ (current date))\n\
         \t\t\t\tif (count of evs) > 0 then\n\
         \t\t\t\t\tset target to item 1 of evs\n\
         \t\t\t\t\texit repeat\n\
         \t\t\t\tend if\n\
         \t\t\tend try\n\
         \t\tend if\n\
         \tend repeat\n\
         \tif target is missing value then error \"no upcoming event named {title_esc}\"\n\
         \t{move_block}\
         \t{rename_line}\
         \t\"ok\"\n\
         end tell"
    );

    tokio::task::spawn_blocking(move || run_applescript(&script))
        .await
        .map_err(|e| format!("spawn_blocking error: {e}"))??;

    Ok(json!({
        "success": true,
        "title": if new_title.is_empty() { title } else { new_title },
        "new_start": new_start,
    }))
}

/// Delete events by exact title (Destructive — withheld from the model by
/// `enabled_tools()`; reachable only after a confirm-card approval once
/// re-enabled). Scans all calendars, or one when `calendar_name` is given.
pub async fn delete_event(args: Value) -> Result<Value, String> {
    let title = args.get("title").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if title.is_empty() {
        return Err("title is required".into());
    }
    let calendar_name = args.get("calendar_name").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let title_esc = as_escape(&title);
    let cal_filter = as_escape(&calendar_name);

    let script = format!(
        "\ntell application \"Calendar\"\n\
         \tset deleted to 0\n\
         \trepeat with c in calendars\n\
         \t\tif \"{cal_filter}\" is \"\" or (name of c) is \"{cal_filter}\" then\n\
         \t\t\tset evs to (events of c whose summary is \"{title_esc}\")\n\
         \t\t\trepeat with e in evs\n\
         \t\t\t\tdelete e\n\
         \t\t\t\tset deleted to deleted + 1\n\
         \t\t\tend repeat\n\
         \t\tend if\n\
         \tend repeat\n\
         \tdeleted as string\n\
         end tell"
    );

    let result = tokio::task::spawn_blocking(move || run_applescript(&script))
        .await
        .map_err(|e| format!("spawn_blocking error: {e}"))??;

    Ok(json!({ "success": true, "title": title, "deleted": result }))
}
