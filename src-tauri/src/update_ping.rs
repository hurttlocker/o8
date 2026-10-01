//! Update checks use a device-only identity, separate from entitlement and sign-in.
use serde::Serialize;
use std::{path::Path, time::Duration};
use tauri::{AppHandle, Manager, Runtime, Webview};
use tauri_plugin_store::StoreExt;
use tauri_plugin_updater::{Update, UpdaterExt};
use uuid::Uuid;

const SERVICE_TIMEOUT: Duration = Duration::from_secs(2);
const FALLBACK_TIMEOUT: Duration = Duration::from_secs(15);

struct UpdateIdentity(String);

pub fn initialize<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let path = app.path().app_config_dir().map_err(|e| e.to_string())?;
    initialize_at(app, &path.join("update-ping.json"))
}

pub fn initialize_at<R: Runtime>(app: &AppHandle<R>, path: &Path) -> Result<(), String> {
    let store = app
        .store_builder(path)
        .disable_auto_save()
        .build()
        .map_err(|e| e.to_string())?;
    let id = match store.get("installId") {
        Some(value) => {
            let id = value.as_str().ok_or("invalid update install identifier")?;
            let parsed = Uuid::parse_str(id).map_err(|e| e.to_string())?;
            if parsed.get_version_num() != 4 || parsed.get_variant() != uuid::Variant::RFC4122 {
                return Err("invalid update install identifier".into());
            }
            id.to_owned()
        }
        None => {
            let id = Uuid::new_v4().to_string();
            store.set("installId", serde_json::json!(id));
            store.save().map_err(|e| e.to_string())?;
            id
        }
    };
    app.manage(UpdateIdentity(id));
    Ok(())
}

fn macos_version() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("/usr/bin/sw_vers")
            .arg("-productVersion")
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let version = String::from_utf8(output.stdout).ok()?.trim().to_owned();
        if version.is_empty() || !version.chars().all(|c| c.is_ascii_digit() || c == '.') {
            return None;
        }
        Some(version)
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

pub async fn check<R: Runtime>(app: &AppHandle<R>) -> Result<Option<Update>, String> {
    let config: tauri_plugin_updater::Config = serde_json::from_value(
        app.config()
            .plugins
            .0
            .get("updater")
            .cloned()
            .ok_or("updater config missing")?,
    )
    .map_err(|e| e.to_string())?;
    let (service, fallback) = config
        .endpoints
        .split_first()
        .ok_or("updater endpoints missing")?;
    if let Some(identity) = app.try_state::<UpdateIdentity>() {
        let channel = if app
            .package_info()
            .version
            .pre
            .as_str()
            .starts_with("preview.")
        {
            "preview"
        } else {
            "stable"
        };
        let primary_host = service.host_str().unwrap_or_default().to_owned();
        let mut builder = app
            .updater_builder()
            .clear_headers()
            .endpoints(vec![service.clone()])
            .map_err(|e| e.to_string())?
            .timeout(SERVICE_TIMEOUT)
            .header("X-O8-Install-Id", identity.0.as_str())
            .map_err(|e| e.to_string())?
            .header("X-O8-Channel", channel)
            .map_err(|e| e.to_string())?
            // A service redirect means fail over locally, without forwarding the ID.
            // Artifact download redirects still use the updater's normal transport.
            .configure_client(move |client| {
                let host = primary_host.clone();
                client.redirect(reqwest::redirect::Policy::custom(move |attempt| {
                    if attempt.previous().first().and_then(|url| url.host_str())
                        == Some(host.as_str())
                    {
                        attempt.stop()
                    } else if attempt.previous().len() >= 10 {
                        attempt.error("too many redirects")
                    } else {
                        attempt.follow()
                    }
                }))
            });
        if let Some(version) = macos_version() {
            builder = builder
                .header("X-O8-Macos-Version", version)
                .map_err(|e| e.to_string())?;
        }
        let updater = builder.build().map_err(|e| e.to_string())?;
        // Also bound response-body parsing, including a stalled successful response.
        if let Ok(Ok(result)) = tokio::time::timeout(SERVICE_TIMEOUT, updater.check()).await {
            return Ok(result.map(|mut update| {
                update.headers.clear();
                update
            }));
        }
    }
    app.updater_builder()
        .clear_headers()
        .endpoints(fallback.to_vec())
        .map_err(|e| e.to_string())?
        .timeout(FALLBACK_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMetadata {
    rid: tauri::ResourceId,
    current_version: String,
    version: String,
    date: Option<String>,
    body: Option<String>,
    raw_json: serde_json::Value,
}

#[tauri::command]
pub async fn check_app_update<R: Runtime>(
    webview: Webview<R>,
) -> Result<Option<UpdateMetadata>, String> {
    let Some(update) = check(webview.app_handle()).await? else {
        return Ok(None);
    };
    let metadata = UpdateMetadata {
        current_version: update.current_version.clone(),
        version: update.version.clone(),
        date: update
            .date
            .map(|date| date.format(&time::format_description::well_known::Rfc3339))
            .transpose()
            .map_err(|e| e.to_string())?,
        body: update.body.clone(),
        raw_json: update.raw_json.clone(),
        rid: webview.resources_table().add(update),
    };
    Ok(Some(metadata))
}
