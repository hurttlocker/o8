//! CSV tools — csv_read (ReadOnly) / csv_write (Reversible). Pure-Rust parse +
//! serialize; csv_write is sandboxed to `~/.o8/agent-output/` by bare filename.
//! Ported from aqua/Symon to o8's `Result<Value, String>` (no `dirs` dep).

use serde_json::{json, Value};
use std::io::Write;

fn agent_output_dir() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    std::path::PathBuf::from(home).join(".o8").join("agent-output")
}

pub async fn read(args: Value) -> Result<Value, String> {
    let path_str = args.get("path").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if path_str.is_empty() {
        return Err("path is required".into());
    }
    if crate::agent::safety::is_never_do_path(&path_str) {
        return Err(format!("Path '{path_str}' is protected"));
    }

    let content = tokio::fs::read_to_string(&path_str)
        .await
        .map_err(|e| format!("Failed to read CSV {path_str}: {e}"))?;

    let rows: Vec<Vec<String>> = content.lines().map(parse_csv_line).collect();
    let (headers, data_rows) = if rows.is_empty() {
        (vec![], vec![])
    } else {
        let (h, r) = rows.split_at(1);
        (h[0].clone(), r.to_vec())
    };

    Ok(json!({
        "path": path_str,
        "headers": headers,
        "rows": data_rows,
        "row_count": data_rows.len(),
    }))
}

pub async fn write(args: Value) -> Result<Value, String> {
    let filename = args.get("filename").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if filename.is_empty() {
        return Err("filename is required".into());
    }
    let headers: Vec<String> = args
        .get("headers")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let rows: Vec<Vec<String>> = args
        .get("rows")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|row| {
                    row.as_array()
                        .map(|r| r.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                })
                .collect()
        })
        .unwrap_or_default();

    // Strip any directory separators — only bare filenames in the sandbox.
    let safe_filename = std::path::Path::new(&filename)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("output.csv")
        .to_string();

    let output_dir = agent_output_dir();
    super::ensure_directory_tree_no_symlinks(&output_dir)
        .await
        .map_err(|e| format!("Agent output sandbox is not trusted: {e}"))?;
    let path = output_dir.join(&safe_filename);
    let path_str = path.to_string_lossy().to_string();
    let rows_len = rows.len();

    let content = tokio::task::spawn_blocking(move || -> Result<String, String> {
        let mut buf = Vec::new();
        writeln!(buf, "{}", csv_row(&headers)).map_err(|e| format!("CSV write error: {e}"))?;
        for row in &rows {
            writeln!(buf, "{}", csv_row(row)).map_err(|e| format!("CSV write error: {e}"))?;
        }
        String::from_utf8(buf).map_err(|e| format!("UTF-8 error: {e}"))
    })
    .await
    .map_err(|e| format!("spawn_blocking error: {e}"))??;

    super::write_file_no_follow(&path, content.as_bytes())
        .await
        .map_err(|e| format!("Failed to write CSV: {e}"))?;

    Ok(json!({ "success": true, "path": path_str, "rows_written": rows_len }))
}

fn csv_row(fields: &[String]) -> String {
    fields
        .iter()
        .map(|f| {
            if f.contains(',') || f.contains('"') || f.contains('\n') {
                format!("\"{}\"", f.replace('"', "\"\""))
            } else {
                f.clone()
            }
        })
        .collect::<Vec<_>>()
        .join(",")
}

fn parse_csv_line(line: &str) -> Vec<String> {
    let mut fields = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut chars = line.chars().peekable();

    while let Some(c) = chars.next() {
        match c {
            '"' if !in_quotes => in_quotes = true,
            '"' if in_quotes => {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    current.push('"');
                } else {
                    in_quotes = false;
                }
            }
            ',' if !in_quotes => fields.push(std::mem::take(&mut current)),
            other => current.push(other),
        }
    }
    fields.push(current);
    fields
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_row_escapes_commas() {
        let row = vec!["hello".to_string(), "world,comma".to_string(), "plain".to_string()];
        assert_eq!(csv_row(&row), "hello,\"world,comma\",plain");
    }

    #[test]
    fn parse_csv_line_quoted() {
        assert_eq!(parse_csv_line("\"hello, world\",b"), vec!["hello, world", "b"]);
    }

    #[test]
    fn csv_round_trip() {
        let headers = vec!["name".to_string(), "value".to_string()];
        assert_eq!(parse_csv_line(&csv_row(&headers)), headers);
    }
}
