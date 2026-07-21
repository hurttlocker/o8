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
         \tset sep to character id 30\n\
         \tset recordSep to character id 29\n\
         \tset createdList to false\n\
         \tif not (exists list \"{list_esc}\") then\n\
         \t\tmake new list with properties {{name:\"{list_esc}\"}}\n\
         \t\tset createdList to true\n\
         \tend if\n\
         \tset targetList to list \"{list_esc}\"\n\
         \tset newReminder to make new reminder at end of reminders of targetList with properties {{name:\"{title_esc}\"}}\n\
         \t{due_date_line}\
         \t{notes_line}\
         \tset dueText to \"missing\"\n\
         \tif due date of newReminder is not missing value then set dueText to (due date of newReminder as string)\n\
         \tset reminderFingerprint to (name of newReminder as string) & sep & (completed of newReminder as string) & sep & (body of newReminder as string) & sep & dueText & sep & (name of container of newReminder as string)\n\
         \t(id of newReminder as string) & recordSep & reminderFingerprint & recordSep & (createdList as string)\n\
         end tell"
    );

    let created = tokio::task::spawn_blocking(move || run_applescript(&script))
        .await
        .map_err(|e| format!("spawn_blocking error: {e}"))??;
    let mut created_parts = created.splitn(3, '\u{1d}');
    let reminder_id = created_parts.next().unwrap_or("");
    let fingerprint = created_parts.next().unwrap_or("");
    let created_list = created_parts.next().unwrap_or("") == "true";
    if reminder_id.is_empty() || fingerprint.is_empty() {
        return Err("Reminders did not return a stable post-create fingerprint".to_string());
    }

    Ok(json!({
        "success": true,
        "title": title,
        "list": list_name,
        "due_date": due_date,
        "reminder_id": reminder_id,
        "_ledger_fingerprint": fingerprint,
        "_ledger_created_list": if created_list { Some(list_name.as_str()) } else { None },
    }))
}

/// Exact inverse for a ledger token produced by `create`. It is not exposed as
/// a model tool; only the separately confirmed ledger undo can reach it.
pub async fn delete_created(
    reminder_id: &str,
    expected_sha256: &str,
    created_list: Option<&str>,
) -> Result<Value, String> {
    let id = as_escape(reminder_id);
    let expected = as_escape(expected_sha256);
    let created_list = as_escape(created_list.unwrap_or(""));
    let script = format!(
        "\ntell application \"Reminders\"\n\
         \tset sep to character id 30\n\
         \tset deletedCount to 0\n\
         \trepeat with reminderList in lists\n\
         \t\tset matches to reminders of reminderList whose id is \"{id}\"\n\
         \t\trepeat with r in matches\n\
         \t\t\tset dueText to \"missing\"\n\
         \t\t\tif due date of r is not missing value then set dueText to (due date of r as string)\n\
         \t\t\tset currentFingerprint to (name of r as string) & sep & (completed of r as string) & sep & (body of r as string) & sep & dueText & sep & (name of container of r as string)\n\
         \t\t\tset digestOutput to do shell script \"/usr/bin/printf %s \" & quoted form of currentFingerprint & \" | /usr/bin/shasum -a 256\"\n\
         \t\t\tset currentHash to text 1 thru 64 of digestOutput\n\
         \t\t\tif currentHash is not \"{expected}\" then return \"changed\"\n\
         \t\t\tdelete r\n\
         \t\t\tset deletedCount to deletedCount + 1\n\
         \t\t\tif \"{created_list}\" is not \"\" and (name of reminderList as string) is \"{created_list}\" then\n\
         \t\t\t\tif (count of reminders of reminderList) is 0 then\n\
         \t\t\t\t\tdelete reminderList\n\
         \t\t\t\t\treturn \"1\" & sep & \"true\"\n\
         \t\t\t\tend if\n\
         \t\t\tend if\n\
         \t\t\treturn \"1\" & sep & \"false\"\n\
         \t\tend repeat\n\
         \tend repeat\n\
         \t(deletedCount as string) & sep & \"false\"\n\
         end tell"
    );
    let deleted = tokio::task::spawn_blocking(move || run_applescript(&script))
        .await
        .map_err(|e| format!("spawn_blocking error: {e}"))??;
    let mut deleted_parts = deleted.trim().splitn(2, '\u{1e}');
    match deleted_parts.next().unwrap_or("") {
        "1" => Ok(json!({
            "undone": true,
            "reminder_id": reminder_id,
            "created_list_removed": deleted_parts.next() == Some("true"),
        })),
        "changed" => Err("Cannot undo because the reminder changed after Symon created it".into()),
        _ => Err("The created reminder no longer exists exactly as recorded".into()),
    }
}

/// Update an existing (incomplete) reminder in place — rename, move the due
/// date, or rewrite the notes. Matches by EXACT name (the prompt teaches the
/// model to list first); duplicates update the first match only.
pub async fn update(args: Value) -> Result<Value, String> {
    let title = args.get("title").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if title.is_empty() {
        return Err("title is required — list the reminders first to get the exact name".into());
    }
    let new_title = args.get("new_title").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let new_due = args.get("new_due_date").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let new_notes = args.get("new_notes").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if new_title.is_empty() && new_due.is_empty() && new_notes.is_empty() {
        return Err("nothing to change — give new_title, new_due_date, or new_notes".into());
    }
    let list_name = args.get("list_name").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let list_clause = if list_name.is_empty() {
        String::new()
    } else {
        format!("of list \"{}\"", as_escape(&list_name))
    };

    let due_block = match (!new_due.is_empty()).then(|| parse_due_components(&new_due)).flatten() {
        Some(comps) => format!(
            "{}set due date of r to newDue\n",
            date_setter_block("newDue", comps)
        ),
        None if !new_due.is_empty() => return Err("new_due_date must be ISO 8601".into()),
        None => String::new(),
    };
    let rename_line = if new_title.is_empty() {
        String::new()
    } else {
        format!("set name of r to \"{}\"\n", as_escape(&new_title))
    };
    let notes_line = if new_notes.is_empty() {
        String::new()
    } else {
        format!("set body of r to \"{}\"\n", as_escape(&new_notes))
    };

    let title_esc = as_escape(&title);
    let script = format!(
        "\ntell application \"Reminders\"\n\
         \tset rs to reminders {list_clause} whose name is \"{title_esc}\" and completed is false\n\
         \tif (count of rs) is 0 then error \"no open reminder named {title_esc}\"\n\
         \tset r to item 1 of rs\n\
         \t{due_block}\
         \t{rename_line}\
         \t{notes_line}\
         \t\"ok\"\n\
         end tell"
    );

    tokio::task::spawn_blocking(move || run_applescript(&script))
        .await
        .map_err(|e| format!("spawn_blocking error: {e}"))??;

    Ok(json!({
        "success": true,
        "title": if new_title.is_empty() { title } else { new_title },
        "due_date": new_due,
    }))
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
         \tif found then\n\
         \t\treturn \"done\"\n\
         \telse\n\
         \t\treturn \"not found\"\n\
         \tend if\n\
         end tell"
    );

    let result = tokio::task::spawn_blocking(move || run_applescript(&script))
        .await
        .map_err(|e| format!("spawn_blocking error: {e}"))??;

    Ok(json!({ "success": result == "done", "title": title, "status": result }))
}
