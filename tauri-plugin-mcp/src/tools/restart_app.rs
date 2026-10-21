use log::info;
use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime};

use crate::error::Error;
use crate::models::RestartAppRequest;
use crate::socket_server::SocketResponse;

pub async fn handle_restart_app<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<SocketResponse, Error> {
    let request: RestartAppRequest = serde_json::from_value(payload)
        .map_err(|e| Error::Anyhow(format!("Invalid payload for restart_app: {}", e)))?;

    let safety = app.try_state::<o8_restart_safety::RestartSafety>()
        .ok_or_else(|| Error::Anyhow("Restart ownership is unavailable; no sessions were stopped.".into()))?;
    let reservation = safety.prepare().map_err(Error::Anyhow)?;

    // Clamp delay_ms to 100-5000, default 500
    let delay_ms = request.delay_ms.unwrap_or(500).clamp(100, 5000);

    info!("[TAURI_MCP] Scheduling app restart in {}ms", delay_ms);

    let app_handle = app.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
        let safety = app_handle.state::<o8_restart_safety::RestartSafety>();
        if let Err(error) = safety.before_restart(Some(&reservation)) {
            log::warn!("[TAURI_MCP] Restart refused: {}", error);
            return;
        }
        info!("[TAURI_MCP] Executing app restart now");
        // restart() returns `!` — it terminates the process or blocks forever.
        // This is intentional: the spawned task is fire-and-forget.
        app_handle.restart();
    });

    Ok(SocketResponse {
        success: true,
        data: Some(serde_json::json!({
            "message": format!("Restarting application in {}ms", delay_ms)
        })),
        error: None,
        id: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, atomic::{AtomicUsize, Ordering}};

    #[tokio::test]
    async fn shared_dispatcher_refuses_an_installer_before_restart_or_cleanup() {
        let root = std::env::temp_dir().join(format!("o8-restart-entry-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("codex-cli-update.lock"), "interrupted owner").unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = calls.clone();
        let app = tauri::test::mock_app();
        app.manage(o8_restart_safety::RestartSafety::new(root.clone(), move || {
            counter.fetch_add(1, Ordering::SeqCst);
        }));
        let result = crate::tools::handle_command(app.handle(), crate::shared::commands::RESTART_APP,
            serde_json::json!({"delay_ms": 100})).await;
        assert!(result.is_err(), "the native dispatcher must refuse, never acknowledge a restart");
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(std::fs::read_to_string(root.join("codex-cli-update.lock")).unwrap(), "interrupted owner");
        std::fs::remove_dir_all(root).unwrap();
    }
}
