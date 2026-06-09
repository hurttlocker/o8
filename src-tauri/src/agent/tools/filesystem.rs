//! Filesystem tools — fs_read_text (ReadOnly) / fs_write_text (Reversible) /
//! fs_spotlight (ReadOnly). Writes are sandboxed to o8's agent-output dir:
//! `~/.o8/agent-output/`. Ported from aqua/Symon (which used the `dirs` crate +
//! its own app-support dir; o8 has no `dirs` dep and keys off `~/.o8`).

use serde_json::{json, Value};

/// o8's agent-output sandbox — mirrors `dictation_history::data_dir()`'s `~/.o8`.
fn agent_output_dir() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    std::path::PathBuf::from(home).join(".o8").join("agent-output")
}

pub async fn read_text(args: Value) -> Result<Value, String> {
    let path_str = args.get("path").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if path_str.is_empty() {
        return Err("path is required".into());
    }
    if crate::agent::safety::is_never_do_path(&path_str) {
        return Err(format!("Path '{path_str}' is protected"));
    }

    let content = tokio::fs::read_to_string(&path_str)
        .await
        .map_err(|e| format!("Failed to read {path_str}: {e}"))?;

    // Cap at 8 KB so a large file can't blow the model's context window. Floor
    // the cut to a char boundary so multibyte content never panics the slice.
    let truncated = if content.len() > 8192 {
        let mut end = 8192;
        while !content.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}... [truncated]", &content[..end])
    } else {
        content
    };

    Ok(json!({ "path": path_str, "content": truncated }))
}

pub async fn write_text(args: Value) -> Result<Value, String> {
    let path_str = args.get("path").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let content = args.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if path_str.is_empty() {
        return Err("path is required".into());
    }
    if crate::agent::safety::is_never_do_path(&path_str) {
        return Err(format!("Path '{path_str}' is protected"));
    }

    let path = std::path::PathBuf::from(&path_str);
    // Last line of defense: only the agent-output sandbox is writable. Writes
    // elsewhere are refused even if the loop's confirm gate were bypassed.
    if !path.starts_with(agent_output_dir()) {
        return Err(format!(
            "Write outside the agent output directory is not permitted: {path_str}. Use ~/.o8/agent-output/."
        ));
    }

    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create dirs: {e}"))?;
    }
    tokio::fs::write(&path, &content)
        .await
        .map_err(|e| format!("Failed to write {path_str}: {e}"))?;

    Ok(json!({ "success": true, "path": path_str, "bytes": content.len() }))
}

pub async fn spotlight(args: Value) -> Result<Value, String> {
    let query = args.get("query").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if query.is_empty() {
        return Err("query is required".into());
    }
    let limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(10) as usize;

    let q = query.clone();
    let output = tokio::task::spawn_blocking(move || {
        std::process::Command::new("mdfind").arg(&q).output()
    })
    .await
    .map_err(|e| format!("spawn_blocking error: {e}"))?
    .map_err(|e| format!("mdfind failed: {e}"))?;

    if output.status.success() {
        let paths: Vec<Value> = String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter(|l| !l.trim().is_empty())
            .take(limit)
            .map(|l| json!(l.trim()))
            .collect();
        Ok(json!({ "paths": paths }))
    } else {
        Err(format!(
            "mdfind error: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}
