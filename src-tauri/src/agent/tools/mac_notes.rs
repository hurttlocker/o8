//! Notes tools — search (ReadOnly) / create (Reversible). AppleScript.

use super::{as_escape, run_applescript};
use serde_json::{json, Value};

pub async fn search(args: Value) -> Result<Value, String> {
    let query = args.get("query").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if query.is_empty() {
        return Err("query is required".into());
    }
    let limit = args.get("limit").and_then(|v| v.as_i64()).unwrap_or(5).max(1);
    let query_esc = as_escape(&query);

    // NOTE: aqua used `min(200, …)` which is not a standard AppleScript
    // primitive (errors on systems without a scripting addition). Replaced with
    // an explicit length clamp.
    let script = format!(
        "\ntell application \"Notes\"\n\
         \tset output to \"\"\n\
         \tset noteList to notes whose name contains \"{query_esc}\" or body contains \"{query_esc}\"\n\
         \tset counter to 0\n\
         \trepeat with n in noteList\n\
         \t\tif counter >= {limit} then exit repeat\n\
         \t\tset bodyText to body of n\n\
         \t\tset previewLen to count of characters of bodyText\n\
         \t\tif previewLen > 200 then set previewLen to 200\n\
         \t\tset output to output & name of n & \"|||\" & (text 1 thru previewLen of bodyText) & \"~\"\n\
         \t\tset counter to counter + 1\n\
         \tend repeat\n\
         \toutput\n\
         end tell"
    );

    let raw = tokio::task::spawn_blocking(move || run_applescript(&script))
        .await
        .map_err(|e| format!("spawn_blocking error: {e}"))??;

    let notes: Vec<Value> = raw
        .split('~')
        .filter(|e| !e.trim().is_empty())
        .map(|entry| {
            let mut parts = entry.splitn(2, "|||");
            let title = parts.next().unwrap_or("").trim().to_string();
            let preview = parts.next().unwrap_or("").trim().to_string();
            json!({ "title": title, "preview": preview })
        })
        .collect();

    Ok(json!({ "notes": notes }))
}

pub async fn create(args: Value) -> Result<Value, String> {
    let title = args.get("title").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if title.is_empty() {
        return Err("title is required".into());
    }
    let body = args.get("body").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let folder = args.get("folder").and_then(|v| v.as_str()).unwrap_or("").to_string();

    let folder_clause = if folder.is_empty() {
        String::new()
    } else {
        format!("in folder \"{}\"", as_escape(&folder))
    };
    let title_esc = as_escape(&title);
    let body_esc = as_escape(&body);

    let script = format!(
        "\ntell application \"Notes\"\n\
         \tset sep to character id 30\n\
         \tset newNote to make new note {folder_clause} with properties {{name:\"{title_esc}\", body:\"{body_esc}\"}}\n\
         \tset noteFingerprint to (name of newNote as string) & sep & (body of newNote as string) & sep & (name of container of newNote as string)\n\
         \t(id of newNote as string) & sep & noteFingerprint\n\
         end tell"
    );

    let created = tokio::task::spawn_blocking(move || run_applescript(&script))
        .await
        .map_err(|e| format!("spawn_blocking error: {e}"))??;
    let (note_id, fingerprint) = created
        .split_once('\u{1e}')
        .ok_or_else(|| "Notes did not return a stable post-create fingerprint".to_string())?;

    Ok(json!({
        "success": true,
        "title": title,
        "note_id": note_id,
        "_ledger_fingerprint": fingerprint,
    }))
}

pub async fn delete_created(note_id: &str, expected_sha256: &str) -> Result<Value, String> {
    let id = as_escape(note_id);
    let expected = as_escape(expected_sha256);
    let script = format!(
        "\ntell application \"Notes\"\n\
         \tset sep to character id 30\n\
         \tset matches to notes whose id is \"{id}\"\n\
         \tif (count of matches) is not 1 then return \"not found\"\n\
         \tset targetNote to item 1 of matches\n\
         \tset currentFingerprint to (name of targetNote as string) & sep & (body of targetNote as string) & sep & (name of container of targetNote as string)\n\
         \tset digestOutput to do shell script \"/usr/bin/printf %s \" & quoted form of currentFingerprint & \" | /usr/bin/shasum -a 256\"\n\
         \tset currentHash to text 1 thru 64 of digestOutput\n\
         \tif currentHash is not \"{expected}\" then return \"changed\"\n\
         \tdelete targetNote\n\
         \t\"deleted\"\n\
         end tell"
    );
    let deleted = tokio::task::spawn_blocking(move || run_applescript(&script))
        .await
        .map_err(|e| format!("spawn_blocking error: {e}"))??;
    match deleted.trim() {
        "deleted" => Ok(json!({ "undone": true, "note_id": note_id })),
        "changed" => Err("Cannot undo because the note changed after Symon created it".into()),
        _ => Err("The created note no longer exists exactly as recorded".into()),
    }
}

pub async fn append(args: Value) -> Result<Value, String> {
    let title = args.get("title").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if title.is_empty() {
        return Err("title is required".into());
    }
    let text = args.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if text.is_empty() {
        return Err("text is required".into());
    }
    let title_esc = as_escape(&title);
    // Notes bodies are HTML — append on a fresh line via <br>.
    let text_esc = as_escape(&text);

    let script = format!(
        "\ntell application \"Notes\"\n\
         \tset matches to notes whose name is \"{title_esc}\"\n\
         \tif (count of matches) is 0 then return \"not found\"\n\
         \tset n to item 1 of matches\n\
         \tset body of n to (body of n) & \"<br>\" & \"{text_esc}\"\n\
         \t\"appended\"\n\
         end tell"
    );

    let result = tokio::task::spawn_blocking(move || run_applescript(&script))
        .await
        .map_err(|e| format!("spawn_blocking error: {e}"))??;

    Ok(json!({ "success": result == "appended", "title": title, "status": result }))
}
