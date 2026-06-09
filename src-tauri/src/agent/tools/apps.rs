//! `open_app` — launch/foreground a macOS app via `open -a`. ReadOnly.

use serde_json::{json, Value};

pub async fn open_app(args: Value) -> Result<Value, String> {
    let name = args
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if name.is_empty() {
        return Err("name is required".into());
    }
    let app = name.clone();
    // `open -a` takes the name as a separate argv (no shell), so it can't inject.
    let result = tokio::task::spawn_blocking(move || {
        std::process::Command::new("open").arg("-a").arg(&app).output()
    })
    .await
    .map_err(|e| format!("spawn_blocking error: {e}"))?;

    match result {
        Ok(out) if out.status.success() => Ok(json!({ "success": true, "app": name })),
        Ok(out) => Err(format!(
            "Could not open '{name}': {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )),
        Err(e) => Err(format!("open failed: {e}")),
    }
}
