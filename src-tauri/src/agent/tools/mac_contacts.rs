//! Contacts tool — search (ReadOnly). AppleScript via osascript. Ported from
//! aqua/Symon to o8's `Result<Value, String>` + the shared `as_escape`/`run_applescript`.

use super::{as_escape, run_applescript};
use serde_json::{json, Value};

pub async fn search(args: Value) -> Result<Value, String> {
    let query = args.get("query").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if query.is_empty() {
        return Err("query is required".into());
    }
    let limit = args.get("limit").and_then(|v| v.as_i64()).unwrap_or(5).max(1);
    let query = as_escape(&query);

    let script = format!(
        r#"
tell application "Contacts"
    set output to ""
    set allPeople to every person whose (first name contains "{query}") or (last name contains "{query}") or (name contains "{query}")
    set counter to 0
    repeat with p in allPeople
        if counter >= {limit} then exit repeat
        set pName to name of p
        set pEmail to ""
        if (count of emails of p) > 0 then set pEmail to value of (item 1 of emails of p)
        set pPhone to ""
        if (count of phones of p) > 0 then set pPhone to value of (item 1 of phones of p)
        set output to output & pName & "|||" & pEmail & "|||" & pPhone & "~"
        set counter to counter + 1
    end repeat
    output
end tell
"#
    );

    let raw = tokio::task::spawn_blocking(move || run_applescript(&script))
        .await
        .map_err(|e| format!("spawn_blocking error: {e}"))??;

    let contacts: Vec<Value> = raw
        .split('~')
        .filter(|s| !s.trim().is_empty())
        .map(|entry| {
            let mut parts = entry.splitn(3, "|||");
            json!({
                "name": parts.next().unwrap_or("").trim(),
                "email": parts.next().unwrap_or("").trim(),
                "phone": parts.next().unwrap_or("").trim(),
            })
        })
        .collect();

    Ok(json!({ "contacts": contacts }))
}
