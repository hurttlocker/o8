//! Reminders tools — list (ReadOnly) / create (Reversible) / complete
//! (Reversible). AppleScript via osascript. Dates are parsed in Rust and
//! emitted as AppleScript component-setters (AppleScript's `date "..."` can't
//! parse ISO 8601).

use super::{as_escape, date_setter_block, parse_due_components, run_applescript};
use serde_json::{json, Value};

pub async fn list(args: Value) -> Result<Value, String> {
    let list_name = args.get("list_name").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let include_completed = args
        .get("include_completed")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let list_filter = if list_name.is_empty() {
        String::new()
    } else {
        format!("of list \"{}\"", as_escape(&list_name))
    };
    let completed_filter = if include_completed {
        String::new()
    } else {
        "whose completed is false".to_string()
    };

    let script = format!(
        "\ntell application \"Reminders\"\n\
         \tset output to \"\"\n\
         \tset reminderList to reminders {list_filter} {completed_filter}\n\
         \trepeat with r in reminderList\n\
         \t\tset output to output & name of r & \"|||\" & (completed of r as string) & \"|||\"\n\
         \t\tif due date of r is missing value then\n\
         \t\t\tset output to output & \"none\" & \"~\"\n\
         \t\telse\n\
         \t\t\tset output to output & (due date of r as string) & \"~\"\n\
         \t\tend if\n\
         \tend repeat\n\
         \toutput\n\
         end tell"
    );

    let raw = tokio::task::spawn_blocking(move || run_applescript(&script))
        .await
        .map_err(|e| format!("spawn_blocking error: {e}"))??;

    let reminders: Vec<Value> = raw
        .split('~')
        .filter(|e| !e.trim().is_empty())
        .map(|entry| {
            let mut parts = entry.splitn(3, "|||");
            let name = parts.next().unwrap_or("").trim().to_string();
            let completed = parts.next().unwrap_or("").trim() == "true";
            let due = parts.next().unwrap_or("").trim().to_string();
            json!({ "title": name, "completed": completed, "due_date": due })
        })
        .collect();

    Ok(json!({ "reminders": reminders }))
}

pub async fn create(args: Value) -> Result<Value, String> {
    let title = args.get("title").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if title.is_empty() {
        return Err("title is required".into());
    }
    let due_date = args.get("due_date").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let notes = args.get("notes").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let list_name = args
        .get("list_name")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("Reminders")
        .to_string();

    let due_date_line = match (!due_date.is_empty()).then(|| parse_due_components(&due_date)).flatten() {
        Some(comps) => format!(
            "{}set due date of newReminder to dueDate\n",
            date_setter_block("dueDate", comps)
        ),
        None => String::new(),
    };
    let notes_line = if notes.is_empty() {
        String::new()
    } else {
        format!("set body of newReminder to \"{}\"\n", as_escape(&notes))
    };

    let list_esc = as_escape(&list_name);
    let title_esc = as_escape(&title);
    let script = format!(
        "\ntell application \"Reminders\"\n\
         \tif not (exists list \"{list_esc}\") then\n\
         \t\tmake new list with properties {{name:\"{list_esc}\"}}\n\
         \tend if\n\
         \tset targetList to list \"{list_esc}\"\n\
         \tset newReminder to make new reminder at end of reminders of targetList with properties {{name:\"{title_esc}\"}}\n\
         \t{due_date_line}\
         \t{notes_line}\
         end tell"
    );

    tokio::task::spawn_blocking(move || run_applescript(&script))
        .await
        .map_err(|e| format!("spawn_blocking error: {e}"))??;

    Ok(json!({ "success": true, "title": title, "list": list_name, "due_date": due_date }))
}

pub async fn complete(args: Value) -> Result<Value, String> {
    let title = args.get("title").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if title.is_empty() {
        return Err("title is required".into());
    }
    let list_name = args.get("list_name").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let list_clause = if list_name.is_empty() {
        String::new()
    } else {
        format!("of list \"{}\"", as_escape(&list_name))
    };
    let title_esc = as_escape(&title);

    let script = format!(
        "\ntell application \"Reminders\"\n\
         \tset found to false\n\
         \tset rs to reminders {list_clause} whose name is \"{title_esc}\"\n\
         \trepeat with r in rs\n\
         \t\tset completed of r to true\n\
         \t\tset found to true\n\
         \tend repeat\n\
         \tif found then \"done\" else \"not found\"\n\
         end tell"
    );

    let result = tokio::task::spawn_blocking(move || run_applescript(&script))
        .await
        .map_err(|e| format!("spawn_blocking error: {e}"))??;

    Ok(json!({ "success": result == "done", "title": title, "status": result }))
}
