//! Narrow control of the app's existing directory sheet, never a new picker.
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Runtime};

use crate::{shared::commands, socket_server::SocketResponse};

#[cfg(target_os = "macos")]
#[path = "directory_dialog_macos.rs"]
mod macos;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Inspect {
    #[serde(default = "main_label")]
    window_label: String,
}

fn main_label() -> String {
    "main".into()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Operation {
    Select,
    Cancel,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Resolve {
    #[serde(default = "main_label")]
    window_label: String,
    dialog_id: String,
    operation: Operation,
    path: Option<String>,
}

#[derive(Debug)]
pub(super) enum Request {
    Inspect,
    Resolve {
        dialog_id: String,
        operation: Operation,
    },
}

pub(super) fn failure(code: &str, reason: &str) -> SocketResponse {
    SocketResponse {
        success: false,
        data: Some(json!({ "code": code, "reason": reason })),
        error: Some(code.into()),
        id: None,
    }
}

pub(super) fn response(data: Value) -> SocketResponse {
    SocketResponse {
        success: true,
        data: Some(data),
        error: None,
        id: None,
    }
}

// Called by the shared socket dispatcher. Validation happens before native work.
fn parse(command: &str, payload: Value) -> Result<Request, SocketResponse> {
    let schema_error = |_| failure("invalid_schema", "Invalid directory dialog payload");
    let label;
    let request = match command {
        commands::INSPECT_DIRECTORY_DIALOG => {
            let params: Inspect = serde_json::from_value(payload).map_err(schema_error)?;
            label = params.window_label;
            Request::Inspect
        }
        commands::RESOLVE_DIRECTORY_DIALOG => {
            let params: Resolve = serde_json::from_value(payload).map_err(schema_error)?;
            label = params.window_label;
            if params.dialog_id.is_empty() {
                return Err(failure(
                    "invalid_identity",
                    "Inspection identity is required",
                ));
            }
            match (&params.operation, params.path) {
                (Operation::Select, Some(path)) => {
                    validate_path(&path)?;
                }
                (Operation::Cancel, None) => {}
                _ => {
                    return Err(failure(
                        "invalid_operation",
                        "Select requires path; cancel forbids path",
                    ));
                }
            };
            Request::Resolve {
                dialog_id: params.dialog_id,
                operation: params.operation,
            }
        }
        _ => {
            return Err(failure(
                "unknown_command",
                "Unknown directory dialog command",
            ));
        }
    };
    if label != "main" {
        return Err(failure("wrong_window", "Only the main window is supported"));
    }
    Ok(request)
}

pub(super) fn validate_path(path: &str) -> Result<PathBuf, SocketResponse> {
    let candidate = PathBuf::from(path);
    if path.contains('\0') || !candidate.is_absolute() || !candidate.is_dir() {
        return Err(failure(
            "invalid_path",
            "An absolute existing directory is required",
        ));
    }
    candidate
        .canonicalize()
        .map_err(|_| failure("invalid_path", "Directory cannot be resolved"))
}

// Shared identity/type policy, also exercised through the socket dispatcher.
pub(super) fn check_live(
    is_panel: bool,
    attached_to_main: bool,
    visible: bool,
    directories: bool,
    files: bool,
    multiple: bool,
) -> Result<(), SocketResponse> {
    if !is_panel || !attached_to_main || !visible || !directories || files || multiple {
        return Err(failure(
            "wrong_dialog_type",
            "Only a live single-directory NSOpenPanel attached to main is supported",
        ));
    }
    Ok(())
}

// Keep picker-only selector reads lazy until runtime class membership is known.
pub(super) fn check_panel(
    is_panel: bool,
    details: impl FnOnce() -> [bool; 5],
) -> Result<(), SocketResponse> {
    if !is_panel {
        return check_live(false, false, false, false, false, false);
    }
    let [attached, visible, directories, files, multiple] = details();
    check_live(is_panel, attached, visible, directories, files, multiple)
}

pub(super) fn check_identity(
    current: &str,
    supplied: &str,
    claimed: bool,
    dispatched: bool,
    operation: &Operation,
) -> Result<(), SocketResponse> {
    if current != supplied {
        return Err(failure(
            "stale_dialog",
            "Inspect the current dialog before resolving",
        ));
    }
    if claimed && !(matches!(operation, Operation::Cancel) && !dispatched) {
        return Err(failure(
            "already_accepted",
            "Resolve was already accepted; inspect and reconcile setup status, do not retry",
        ));
    }
    Ok(())
}

// NSOpenPanel selected URLs are read-only. directoryURL controls navigation,
// not selection; never dispatch OK for an unobserved requested selection.
pub(super) fn reject_selection() -> SocketResponse {
    failure(
        "selection_not_supported",
        "Live native selection is unsupported; cancel the inspected picker, observe closure, then use o8_setup open and status. No selection action taken",
    )
}

#[cfg(test)]
pub(super) mod fixture {
    use super::*;
    pub static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    pub struct Panel {
        pub identity: &'static str,
        pub claimed: bool,
        pub dispatched: bool,
        pub flags: [bool; 6],
    }
    pub static PANEL: std::sync::Mutex<Option<Panel>> = std::sync::Mutex::new(None);
    pub fn handle(request: &Request) -> Option<SocketResponse> {
        let mut slot = PANEL.lock().unwrap();
        let panel = slot.as_mut()?;
        let [is_panel, attached, visible, directories, files, multiple] = panel.flags;
        if let Err(error) = check_live(is_panel, attached, visible, directories, files, multiple) {
            return Some(error);
        }
        if let Request::Resolve {
            dialog_id,
            operation,
            ..
        } = request
        {
            if let Err(error) = check_identity(
                panel.identity,
                dialog_id,
                panel.claimed,
                panel.dispatched,
                operation,
            ) {
                return Some(error);
            }
            if matches!(operation, Operation::Select) {
                return Some(reject_selection());
            }
            panel.claimed = true;
            panel.dispatched = matches!(operation, Operation::Cancel);
        }
        Some(response(
            json!({ "dialog_id":panel.identity, "status": if panel.claimed { "pending" } else { "live" } }),
        ))
    }
}

pub(super) fn effect_if_active(
    deadline: Instant,
    receiver_closed: bool,
    effect: impl FnOnce(),
) -> Result<(), SocketResponse> {
    if receiver_closed || Instant::now() >= deadline {
        return Err(failure(
            "request_expired",
            "Request expired or receiver closed; no further native action taken",
        ));
    }
    effect();
    Ok(())
}

pub(super) async fn validate_off_main<T: Send + 'static>(
    deadline: Instant,
    validate: impl FnOnce() -> Result<T, SocketResponse> + Send + 'static,
) -> Result<T, SocketResponse> {
    match tokio::time::timeout_at(
        tokio::time::Instant::from_std(deadline),
        tokio::task::spawn_blocking(validate),
    )
    .await
    {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err(failure(
            "validation_unavailable",
            "Directory validation worker failed; no native action taken",
        )),
        Err(_) => Err(failure(
            "request_expired",
            "Directory validation exceeded request deadline; no native action taken",
        )),
    }
}

pub async fn handle<R: Runtime>(
    app: &AppHandle<R>,
    command: &str,
    payload: Value,
) -> crate::Result<SocketResponse> {
    let deadline = Instant::now() + Duration::from_secs(2);
    let command = command.to_owned();
    let request = match validate_off_main(deadline, move || parse(&command, payload)).await {
        Ok(request) => request,
        Err(error) => return Ok(error),
    };
    #[cfg(test)]
    if let Some(result) = fixture::handle(&request) {
        return Ok(result);
    }
    #[cfg(target_os = "macos")]
    {
        macos::handle(app, request, deadline).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, request);
        Ok(failure(
            "unsupported_os",
            "Directory dialog control requires macOS",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nonpicker_refusal_does_not_read_picker_selectors() {
        let reads = std::cell::Cell::new(0);
        let result = check_panel(false, || {
            reads.set(reads.get() + 1);
            [true, true, true, false, false]
        });
        assert_eq!(
            result.unwrap_err().error.as_deref(),
            Some("wrong_dialog_type")
        );
        assert_eq!(
            reads.get(),
            0,
            "Nonpicker objects must not receive picker selectors"
        );
    }

    #[tokio::test]
    async fn slow_validation_and_closed_receivers_cannot_dispatch_late_effects() {
        let effects = std::cell::Cell::new(0);
        let deadline = Instant::now() + Duration::from_millis(5);
        let result = validate_off_main(deadline, || {
            std::thread::sleep(Duration::from_millis(30));
            Ok(())
        })
        .await;
        assert_eq!(
            result.unwrap_err().error.as_deref(),
            Some("request_expired")
        );
        assert!(effect_if_active(deadline, false, || effects.set(1)).is_err());
        assert!(
            effect_if_active(Instant::now() + Duration::from_secs(1), true, || effects
                .set(1))
            .is_err()
        );
        assert_eq!(effects.get(), 0);
    }

    #[test]
    fn shared_commands_validate_schema_and_path_before_native_dispatch() {
        assert!(matches!(
            parse(commands::INSPECT_DIRECTORY_DIALOG, json!({})),
            Ok(Request::Inspect)
        ));
        for payload in [json!({"operation":"cancel"}), json!({"window_label":3})] {
            assert_eq!(
                parse(commands::INSPECT_DIRECTORY_DIALOG, payload)
                    .unwrap_err()
                    .error
                    .as_deref(),
                Some("invalid_schema")
            );
        }
        assert_eq!(
            parse(
                commands::INSPECT_DIRECTORY_DIALOG,
                json!({"window_label":"dock"})
            )
            .unwrap_err()
            .error
            .as_deref(),
            Some("wrong_window")
        );
        for path in ["relative", "/does-not-exist-3138", "/tmp/\0bad"] {
            assert_eq!(
                parse(
                    commands::RESOLVE_DIRECTORY_DIALOG,
                    json!({"dialog_id":"opaque", "operation":"select", "path":path})
                )
                .unwrap_err()
                .error
                .as_deref(),
                Some("invalid_path")
            );
        }
        let file = std::env::current_exe().unwrap();
        assert!(validate_path(file.to_str().unwrap()).is_err());
        let directory = std::env::temp_dir();
        assert!(
            parse(
                commands::RESOLVE_DIRECTORY_DIALOG,
                json!({"dialog_id":"opaque", "operation":"select", "path":directory})
            )
            .is_ok()
        );
        for payload in [
            json!({"dialog_id":"opaque", "operation":"select"}),
            json!({"dialog_id":"opaque", "operation":"cancel", "path":"/tmp"}),
            json!({"dialog_id":"opaque", "operation":"click"}),
            json!({"dialog_id":123, "operation":"cancel"}),
            json!({"operation":"cancel"}),
        ] {
            assert!(parse(commands::RESOLVE_DIRECTORY_DIALOG, payload).is_err());
        }
    }
}
