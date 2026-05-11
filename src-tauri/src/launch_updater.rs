use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Runtime};
use tauri_plugin_updater::UpdaterExt;

const UPDATE_AVAILABLE_EVENT: &str = "o8://update-available";
const UPDATE_CLEAR_EVENT: &str = "o8://update-clear";

static LAUNCH_UPDATE_CHECK_STARTED: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LaunchUpdatePayload {
    version: String,
    current_version: String,
    notes: Option<String>,
    date: Option<String>,
    release_url: Option<String>,
}

pub fn start_launch_update_check<R: Runtime>(app: AppHandle<R>) {
    if LAUNCH_UPDATE_CHECK_STARTED.swap(true, Ordering::AcqRel) {
        return;
    }

    tauri::async_runtime::spawn(async move {
        let updater = match app.updater() {
            Ok(updater) => updater,
            Err(err) => {
                log::warn!("[launch-updater] updater unavailable: {}", err);
                emit_clear(&app);
                return;
            }
        };

        match updater.check().await {
            Ok(Some(update)) => {
                let payload = LaunchUpdatePayload {
                    version: update.version.clone(),
                    current_version: update.current_version.clone(),
                    notes: update.body.clone(),
                    date: update.date.map(|date| date.to_string()),
                    release_url: release_url_from_raw_json(&update.raw_json),
                };
                if let Err(err) = app.emit(UPDATE_AVAILABLE_EVENT, payload) {
                    log::warn!("[launch-updater] emit update-available failed: {}", err);
                }
            }
            Ok(None) => emit_clear(&app),
            Err(err) => {
                log::warn!("[launch-updater] check failed: {}", err);
                emit_clear(&app);
            }
        }
    });
}

fn emit_clear<R: Runtime>(app: &AppHandle<R>) {
    if let Err(err) = app.emit(UPDATE_CLEAR_EVENT, ()) {
        log::warn!("[launch-updater] emit update-clear failed: {}", err);
    }
}

fn release_url_from_raw_json(raw_json: &serde_json::Value) -> Option<String> {
    ["releaseUrl", "release_url", "url"]
        .iter()
        .find_map(|key| raw_json.get(key)?.as_str())
        .map(str::to_owned)
}
