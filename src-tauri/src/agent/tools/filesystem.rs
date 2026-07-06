//! Filesystem tools — fs_read_text (ReadOnly) / fs_write_text (Reversible) /
//! fs_spotlight (ReadOnly). Writes are sandboxed to o8's agent-output dir:
//! `~/.o8/agent-output/`. Ported from aqua/Symon (which used the `dirs` crate +
//! its own app-support dir; o8 has no `dirs` dep and keys off `~/.o8`).

use serde_json::{json, Value};

/// o8's agent-output sandbox — mirrors `dictation_history::data_dir()`'s `~/.o8`.
fn agent_output_dir() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    std::path::PathBuf::from(home)
        .join(".o8")
        .join("agent-output")
}

pub async fn read_text(args: Value) -> Result<Value, String> {
    let path_str = args
        .get("path")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
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
    let path_str = args
        .get("path")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let content = args
        .get("content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if path_str.is_empty() {
        return Err("path is required".into());
    }
    if crate::agent::safety::is_never_do_path(&path_str) {
        return Err(format!("Path '{path_str}' is protected"));
    }

    let path = std::path::PathBuf::from(&path_str);
    // Last line of defense: only the agent-output sandbox is writable. Writes
    // elsewhere are refused even if the loop's confirm gate were bypassed.
    // `starts_with` alone is lexical — `..` is a literal component to it, so
    // `<sandbox>/../../.zshrc` would pass and escape at the OS level. Refuse
    // any traversal component outright, then verify the resolved (symlink-free)
    // parent is still inside the sandbox before writing.
    let has_traversal = path.components().any(|c| {
        !matches!(
            c,
            std::path::Component::Normal(_) | std::path::Component::RootDir
        )
    });
    if has_traversal || !path.starts_with(agent_output_dir()) {
        return Err(format!(
            "Write outside the agent output directory is not permitted: {path_str}. Use ~/.o8/agent-output/."
        ));
    }

    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create dirs: {e}"))?;
        let canon_parent = tokio::fs::canonicalize(parent)
            .await
            .map_err(|e| format!("Failed to resolve {path_str}: {e}"))?;
        let canon_sandbox = tokio::fs::canonicalize(agent_output_dir())
            .await
            .map_err(|e| format!("Failed to resolve sandbox dir: {e}"))?;
        if !canon_parent.starts_with(&canon_sandbox) {
            return Err(format!(
                "Write outside the agent output directory is not permitted: {path_str}. Use ~/.o8/agent-output/."
            ));
        }
    }
    tokio::fs::write(&path, &content)
        .await
        .map_err(|e| format!("Failed to write {path_str}: {e}"))?;

    Ok(json!({ "success": true, "path": path_str, "bytes": content.len() }))
}

#[cfg(test)]
mod write_text_sandbox_tests {
    use super::*;

    /// One test fn so the HOME mutation can't race a parallel test. The fake
    /// home lives under target/ because the safety layer blocks /var/ and
    /// /private/ — which is where macOS temp dirs resolve.
    #[test]
    fn write_text_enforces_the_agent_output_sandbox() {
        let fake_home = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("test-home-{}", std::process::id()));
        let sandbox = fake_home.join(".o8").join("agent-output");
        std::fs::create_dir_all(&sandbox).expect("create sandbox");
        std::env::set_var("HOME", &fake_home);

        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio runtime");

        // 1. Happy path — a write inside the sandbox succeeds and persists.
        let target = sandbox.join("sub").join("note.txt");
        let ok = rt.block_on(write_text(json!({
            "path": target.to_string_lossy(),
            "content": "hello"
        })));
        assert!(ok.is_ok(), "sandboxed write should succeed: {ok:?}");
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "hello");

        // 2. Traversal — `..` components are refused outright, even when the
        //    path lexically starts inside the sandbox.
        let traversal = sandbox.join("..").join("..").join("escape.txt");
        let err = rt
            .block_on(write_text(json!({
                "path": traversal.to_string_lossy(),
                "content": "x"
            })))
            .unwrap_err();
        assert!(
            err.contains("not permitted"),
            "traversal must be refused: {err}"
        );

        // 3. Outside the sandbox — refused lexically.
        let outside = fake_home.join("outside-dir").join("escape.txt");
        let err = rt
            .block_on(write_text(json!({
                "path": outside.to_string_lossy(),
                "content": "x"
            })))
            .unwrap_err();
        assert!(
            err.contains("not permitted"),
            "outside write must be refused: {err}"
        );

        // 4. Symlink escape — lexically inside, resolves outside. The
        //    canonicalize containment check must catch it.
        let outside_dir = fake_home.join("outside-dir");
        std::fs::create_dir_all(&outside_dir).expect("create outside dir");
        let link = sandbox.join("link");
        if link.exists() || link.symlink_metadata().is_ok() {
            let _ = std::fs::remove_file(&link);
        }
        std::os::unix::fs::symlink(&outside_dir, &link).expect("create symlink");
        let through_link = link.join("evil.txt");
        let err = rt
            .block_on(write_text(json!({
                "path": through_link.to_string_lossy(),
                "content": "x"
            })))
            .unwrap_err();
        assert!(
            err.contains("not permitted"),
            "symlink escape must be refused: {err}"
        );
        assert!(
            !outside_dir.join("evil.txt").exists(),
            "no file may land outside the sandbox"
        );

        let _ = std::fs::remove_dir_all(&fake_home);
    }
}

pub async fn spotlight(args: Value) -> Result<Value, String> {
    let query = args
        .get("query")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if query.is_empty() {
        return Err("query is required".into());
    }
    let limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(10) as usize;

    let q = query.clone();
    let output =
        tokio::task::spawn_blocking(move || std::process::Command::new("mdfind").arg(&q).output())
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
