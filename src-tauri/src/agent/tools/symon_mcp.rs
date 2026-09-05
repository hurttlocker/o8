//! Memory-only catalog and Next-server bridge for operator-attached MCP tools.
//! MCP protocol ownership stays in TypeScript; Rust owns voice dispatch and approval.

use serde::Deserialize;
use serde_json::{json, Value};
use std::future::Future;
use std::sync::{OnceLock, RwLock};
use std::time::Duration;

const REFRESH_INTERVAL_SECS: u64 = 5 * 60;

#[derive(Clone, Debug, Default)]
struct CatalogCache {
    tools: Vec<Value>,
    servers: Vec<ConnectedMcpServer>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectedMcpServer {
    pub id: String,
    pub name: String,
    pub tool_names: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogResponse {
    #[serde(default)]
    ok: bool,
    #[serde(default)]
    tools: Vec<Value>,
    #[serde(default)]
    servers: Vec<ConnectedMcpServer>,
    error: Option<String>,
}

fn cache() -> &'static RwLock<CatalogCache> {
    static CACHE: OnceLock<RwLock<CatalogCache>> = OnceLock::new();
    CACHE.get_or_init(|| RwLock::new(CatalogCache::default()))
}

fn replace_cache(tools: Vec<Value>, servers: Vec<ConnectedMcpServer>) -> usize {
    let valid_tools = tools
        .into_iter()
        .filter(|tool| {
            let Some(name) = tool.get("name").and_then(Value::as_str) else {
                return false;
            };
            name.starts_with("mcp__")
                && name.len() <= 64
                && name.chars().all(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '_' | '-')
                })
                && tool.get("parameters").and_then(Value::as_object).is_some()
        })
        .collect::<Vec<_>>();
    let count = valid_tools.len();
    let mut guard = cache()
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *guard = CatalogCache {
        tools: valid_tools,
        servers,
    };
    count
}

pub fn cached_tool_schemas() -> Vec<Value> {
    cache()
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .tools
        .clone()
}

pub fn connected_servers() -> Vec<ConnectedMcpServer> {
    cache()
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .servers
        .clone()
}

async fn refresh_catalog() -> Result<usize, String> {
    let raw = super::super::o8_http::get_json_timeout("/api/symon/mcp/tools", 60).await?;
    let response: CatalogResponse = serde_json::from_value(raw)
        .map_err(|error| format!("Symon MCP catalog returned an invalid response: {error}"))?;
    if !response.ok {
        return Err(response
            .error
            .unwrap_or_else(|| "Symon MCP catalog refresh failed".to_string()));
    }
    Ok(replace_cache(response.tools, response.servers))
}

/// Refresh immediately after Settings changes the attachment registry.
#[tauri::command]
pub async fn symon_mcp_refresh() -> Result<usize, String> {
    refresh_catalog().await
}

/// Refresh off the setup thread, retrying cold-start connection races three times,
/// then continue on the five-minute catalog cadence.
pub fn start_refresh_task() {
    tauri::async_runtime::spawn(async move {
        let mut startup_attempt = 0_u8;
        let mut unavailable_logged = false;
        loop {
            match refresh_catalog().await {
                Ok(count) => {
                    unavailable_logged = false;
                    startup_attempt = 3;
                    log::info!("[symon-mcp] native catalog refreshed ({count} tools)");
                }
                Err(error) => {
                    if !unavailable_logged {
                        unavailable_logged = true;
                        log::warn!("[symon-mcp] native catalog refresh unavailable: {error}");
                    }
                    startup_attempt = startup_attempt.saturating_add(1);
                }
            }
            if startup_attempt < 3 {
                tokio::time::sleep(Duration::from_secs(2)).await;
            } else {
                tokio::time::sleep(Duration::from_secs(REFRESH_INTERVAL_SECS)).await;
            }
        }
    });
}

async fn dispatch_with<F, Fut>(name: &str, args: Value, post: F) -> Value
where
    F: FnOnce(Value) -> Fut,
    Fut: Future<Output = Result<Value, String>>,
{
    let body = json!({ "name": name, "args": args });
    match post(body).await {
        Ok(response) => response,
        Err(error) => json!({
            "ok": false,
            "error": format!("Connected MCP bridge failed: {error}"),
        }),
    }
}

pub async fn dispatch_tool_call(name: &str, args: Value) -> Value {
    dispatch_with(name, args, |body| {
        super::super::o8_http::post_json_timeout("/api/symon/mcp/call", body, 60)
    })
    .await
}

#[cfg(test)]
pub(crate) fn replace_cache_for_test(tools: Vec<Value>, servers: Vec<ConnectedMcpServer>) {
    replace_cache(tools, servers);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_cache_adds_nothing_and_populated_cache_reaches_realtime_tools() {
        replace_cache_for_test(Vec::new(), Vec::new());
        assert!(!super::super::all_tools().iter().any(|tool| {
            tool.get("name")
                .and_then(Value::as_str)
                .is_some_and(|name| name.starts_with("mcp__"))
        }));

        replace_cache_for_test(
            vec![json!({
                "name": "mcp__fixture__echo",
                "description": "Echo a value.",
                "parameters": { "type": "object", "properties": {}, "required": [] }
            })],
            vec![ConnectedMcpServer {
                id: "fixture".to_string(),
                name: "Fixture".to_string(),
                tool_names: vec!["mcp__fixture__echo".to_string()],
            }],
        );
        assert!(crate::agent::realtime_bridge::realtime_tools()
            .iter()
            .any(|tool| tool["name"] == "mcp__fixture__echo"));
        replace_cache_for_test(Vec::new(), Vec::new());
    }

    #[test]
    fn dispatcher_posts_the_external_name_and_structures_bridge_failures() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let success = runtime.block_on(dispatch_with(
            "mcp__fixture__echo",
            json!({ "value": "hello" }),
            |body| async move { Ok(json!({ "ok": true, "received": body })) },
        ));
        assert_eq!(success["received"]["name"], "mcp__fixture__echo");
        assert_eq!(success["received"]["args"]["value"], "hello");

        let failure = runtime.block_on(dispatch_with("mcp__fixture__echo", json!({}), |_| async {
            Err("connection refused".to_string())
        }));
        assert_eq!(failure["ok"], false);
        assert!(failure["error"]
            .as_str()
            .is_some_and(|message| message.contains("connection refused")));
    }
}
