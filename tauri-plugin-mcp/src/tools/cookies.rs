use serde::Deserialize;
use serde_json::Value;
use tauri::{AppHandle, Runtime};

use crate::desktop::get_webview_for_eval;
use crate::socket_server::SocketResponse;

#[derive(Debug, Deserialize)]
struct CookiesPayload {
    window_label: Option<String>,
    action: String,
    url: Option<String>,
}

/// Handler for manage_cookies — get/set/delete cookies
pub async fn handle_manage_cookies<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<SocketResponse, crate::error::Error> {
    let parsed: CookiesPayload = serde_json::from_value(payload).map_err(|e| {
        crate::error::Error::Anyhow(format!("Invalid payload for manage_cookies: {}", e))
    })?;

    let window_label = parsed.window_label.unwrap_or_else(|| "main".to_string());
    let webview = get_webview_for_eval(app, &window_label).ok_or_else(|| {
        crate::error::Error::Anyhow(format!("Webview not found: {}", window_label))
    })?;

    match parsed.action.as_str() {
        "get_all" => match webview.cookies() {
            Ok(cookies) => {
                let cookie_list: Vec<Value> = cookies
                    .iter()
                    .map(|c| {
                        serde_json::json!({
                            "name": c.name(),
                            "value": c.value(),
                        })
                    })
                    .collect();
                Ok(SocketResponse {
                    success: true,
                    data: Some(serde_json::json!({"cookies": cookie_list})),
                    error: None,
                    id: None,
                })
            }
            Err(e) => Ok(SocketResponse {
                success: false,
                data: None,
                error: Some(format!("Failed to get cookies: {}", e)),
                id: None,
            }),
        },
        "get_for_url" => {
            let url = parsed.url.ok_or_else(|| {
                crate::error::Error::Anyhow("'url' is required for get_for_url action".to_string())
            })?;
            match webview.cookies_for_url(
                url.parse()
                    .map_err(|e| crate::error::Error::Anyhow(format!("Invalid URL: {}", e)))?,
            ) {
                Ok(cookies) => {
                    let cookie_list: Vec<Value> = cookies
                        .iter()
                        .map(|c| {
                            serde_json::json!({
                                "name": c.name(),
                                "value": c.value(),
                            })
                        })
                        .collect();
                    Ok(SocketResponse {
                        success: true,
                        data: Some(serde_json::json!({"url": url, "cookies": cookie_list})),
                        error: None,
                        id: None,
                    })
                }
                Err(e) => Ok(SocketResponse {
                    success: false,
                    data: None,
                    error: Some(format!("Failed to get cookies for URL: {}", e)),
                    id: None,
                }),
            }
        }
        "clear_all" => match webview.clear_all_browsing_data() {
            Ok(_) => Ok(SocketResponse {
                success: true,
                data: Some(serde_json::json!({"cleared": true})),
                error: None,
                id: None,
            }),
            Err(e) => Ok(SocketResponse {
                success: false,
                data: None,
                error: Some(format!("Failed to clear browsing data: {}", e)),
                id: None,
            }),
        },
        _ => Ok(SocketResponse {
            success: false,
            data: None,
            error: Some(format!(
                "Unknown action '{}'. Valid actions: get_all, get_for_url, clear_all",
                parsed.action
            )),
            id: None,
        }),
    }
}
