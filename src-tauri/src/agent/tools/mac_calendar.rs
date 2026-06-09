//! Calendar tools — list_events (ReadOnly, JXA) / create_event (Reversible,
//! AppleScript). Listing + querying use JXA; creation uses AppleScript because
//! JXA event creation silently fails to persist. delete_event (Destructive) is
//! deferred to v1.x.

use super::{as_escape, date_setter_block, parse_due_components, run_applescript, run_osascript_jxa};
use serde_json::{json, Value};

/// Escape a string for a JS double-quoted literal.
fn js_escape(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "")
}

pub async fn list_events(args: Value) -> Result<Value, String> {
    // NOTE: aqua multiplied `days_ahead` by 1000 here AND the JXA multiplies by
    // 86400000 — a 1000× window bug. Fixed: use days_ahead directly.
    let days = args.get("days_ahead").and_then(|v| v.as_i64()).unwrap_or(7).max(1);
    let calendar_filter = js_escape(
        args.get("calendar_name").and_then(|v| v.as_str()).unwrap_or(""),
    );

    let script = format!(
        "\nObjC.import('Foundation');\n\
         var cal = Application('Calendar');\n\
         cal.includeStandardAdditions = true;\n\
         var now = new Date();\n\
         var end = new Date(now.getTime() + {days} * 86400000);\n\
         var results = [];\n\
         var calendars = cal.calendars();\n\
         for (var i = 0; i < calendars.length; i++) {{\n\
         \tvar c = calendars[i];\n\
         \tif (\"{calendar_filter}\" !== \"\" && c.name() !== \"{calendar_filter}\") continue;\n\
         \ttry {{\n\
         \t\tvar events = c.events.whose({{_and: [\n\
         \t\t\t{{startDate: {{_greaterThanEquals: now}}}},\n\
         \t\t\t{{startDate: {{_lessThan: end}}}}\n\
         \t\t]}})();\n\
         \t\tfor (var j = 0; j < events.length && results.length < 20; j++) {{\n\
         \t\t\tvar e = events[j];\n\
         \t\t\tresults.push({{\n\
         \t\t\t\ttitle: e.summary(),\n\
         \t\t\t\tstart: e.startDate().toISOString(),\n\
         \t\t\t\tend: e.endDate().toISOString(),\n\
         \t\t\t\tcalendar: c.name(),\n\
         \t\t\t\tnotes: e.description() || \"\"\n\
         \t\t\t}});\n\
         \t\t}}\n\
         \t}} catch(err) {{}}\n\
         }}\n\
         JSON.stringify(results);"
    );

    let raw = tokio::task::spawn_blocking(move || run_osascript_jxa(&script))
        .await
        .map_err(|e| format!("spawn_blocking error: {e}"))??;

    let events: Value = serde_json::from_str(&raw).unwrap_or_else(|_| json!([]));
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
    let script = format!(
        "\ntell application \"Calendar\"\n\
         \t{start_block}\
         \t{end_block}\
         \t{cal_selection}\
         \ttell targetCal\n\
         \t\tmake new event with properties {{summary:\"{title_esc}\", start date:startDate, end date:endDate, description:\"{notes_esc}\"}}\n\
         \tend tell\n\
         \t\"ok\"\n\
         end tell"
    );

    tokio::task::spawn_blocking(move || run_applescript(&script))
        .await
        .map_err(|e| format!("spawn_blocking error: {e}"))??;

    Ok(json!({ "success": true, "title": title }))
}
