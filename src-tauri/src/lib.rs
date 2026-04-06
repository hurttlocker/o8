use serde::Serialize;
use std::process::Command;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};
#[cfg(target_os = "macos")]
use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};
#[cfg(target_os = "windows")]
use window_vibrancy::apply_blur;

// ── Data directory resolution ──

fn cortex_data_dir() -> String {
    std::env::var("CORTEX_IDE_DATA_DIR").unwrap_or_else(|_| {
        let home = std::env::var("HOME").unwrap_or_default();
        format!("{}/.cortex-ide", home)
    })
}

/// Desktop info exposed to the React frontend via invoke
#[derive(Serialize)]
pub struct DesktopInfo {
    pub is_desktop: bool,
    pub platform: String,
    pub version: String,
    pub arch: String,
}

/// Result from spawning the WS server sidecar
#[derive(Serialize)]
pub struct SidecarResult {
    pub ok: bool,
    pub pid: Option<u32>,
    pub error: Option<String>,
}

/// Get desktop environment info
#[tauri::command]
fn get_desktop_info() -> DesktopInfo {
    DesktopInfo {
        is_desktop: true,
        platform: std::env::consts::OS.to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        arch: std::env::consts::ARCH.to_string(),
    }
}

/// Check if a process is listening on a given port
#[tauri::command]
fn check_port(port: u16) -> bool {
    std::net::TcpStream::connect(format!("127.0.0.1:{}", port)).is_ok()
}

/// Start the WebSocket server as a background process
#[tauri::command]
fn start_ws_server(project_dir: String) -> SidecarResult {
    match Command::new("npx")
        .args(["tsx", "src/ws-server.ts"])
        .current_dir(&project_dir)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        Ok(child) => SidecarResult {
            ok: true,
            pid: Some(child.id()),
            error: None,
        },
        Err(e) => SidecarResult {
            ok: false,
            pid: None,
            error: Some(e.to_string()),
        },
    }
}

/// Check if Cortex binary is available
#[tauri::command]
fn cortex_available() -> bool {
    let home = std::env::var("HOME").unwrap_or_default();
    let cortex_path = format!("{}/bin/cortex", home);
    std::path::Path::new(&cortex_path).exists()
}

/// Get the app data directory for persistent storage
#[tauri::command]
fn get_app_data_dir(app: tauri::AppHandle) -> Option<String> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|p| p.to_string_lossy().to_string())
}

// ── IPC-accelerated data commands ──
// These bypass HTTP, serving data directly via Tauri IPC (~0.5ms vs ~5-10ms).

/// Read the repo registry from disk. Returns { repos: [...] }.
/// Equivalent to GET /api/panel/repos but without readiness enrichment.
#[tauri::command]
fn read_repos() -> Result<serde_json::Value, String> {
    let repos_path = format!("{}/repos.json", cortex_data_dir());
    let content = std::fs::read_to_string(&repos_path)
        .map_err(|e| format!("Failed to read repos.json: {}", e))?;
    let store: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse repos.json: {}", e))?;
    // repos.json has { repos: [...], ... } — return the whole store
    Ok(store)
}

/// Read recent git commits for a local repo path.
/// Equivalent to GET /api/panel/commits?workspace=<path>&limit=<n>
#[tauri::command]
fn read_local_commits(repo: String, limit: Option<u32>) -> Result<serde_json::Value, String> {
    let limit = limit.unwrap_or(10).min(50);
    let output = Command::new("git")
        .args([
            "log",
            &format!("--max-count={}", limit),
            "--date=iso-strict",
            "--format=%H\x1f%an\x1f%aI\x1f%s",
        ])
        .current_dir(&repo)
        .output()
        .map_err(|e| format!("git log failed: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git log error: {}", stderr.trim()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let commits: Vec<serde_json::Value> = stdout
        .lines()
        .filter(|l| !l.is_empty())
        .map(|line| {
            let parts: Vec<&str> = line.splitn(4, '\x1f').collect();
            serde_json::json!({
                "hash": parts.first().unwrap_or(&""),
                "author": parts.get(1).unwrap_or(&""),
                "date": parts.get(2).unwrap_or(&""),
                "message": parts.get(3).unwrap_or(&""),
            })
        })
        .collect();

    Ok(serde_json::json!({ "commits": commits, "workspace": repo }))
}

/// Read git worktrees for a local repo path.
/// Equivalent to GET /api/worktrees?repo=<path>
#[tauri::command]
fn read_worktrees(repo: String) -> Result<serde_json::Value, String> {
    let output = Command::new("git")
        .args(["worktree", "list", "--porcelain"])
        .current_dir(&repo)
        .output()
        .map_err(|e| format!("git worktree list failed: {}", e))?;

    if !output.status.success() {
        return Ok(serde_json::json!({ "worktrees": [] }));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut worktrees: Vec<serde_json::Value> = Vec::new();
    let mut path = String::new();
    let mut head = String::new();
    let mut branch = String::new();
    let mut is_bare = false;

    for line in stdout.lines() {
        if line.starts_with("worktree ") {
            // Flush previous entry
            if !path.is_empty() {
                worktrees.push(serde_json::json!({
                    "path": path,
                    "head": head,
                    "branch": branch,
                    "bare": is_bare,
                }));
            }
            path = line[9..].to_string();
            head.clear();
            branch.clear();
            is_bare = false;
        } else if line.starts_with("HEAD ") {
            head = line[5..].to_string();
        } else if line.starts_with("branch ") {
            branch = line[7..].trim_start_matches("refs/heads/").to_string();
        } else if line == "bare" {
            is_bare = true;
        }
    }
    // Flush last entry
    if !path.is_empty() {
        worktrees.push(serde_json::json!({
            "path": path,
            "head": head,
            "branch": branch,
            "bare": is_bare,
        }));
    }

    Ok(serde_json::json!({ "worktrees": worktrees }))
}

/// Read the current git branch for a repo.
#[tauri::command]
fn read_current_branch(repo: String) -> Result<serde_json::Value, String> {
    let output = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(&repo)
        .output()
        .map_err(|e| format!("git rev-parse failed: {}", e))?;

    let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(serde_json::json!({ "branch": branch }))
}

/// Read git status (changed files count) for a repo.
#[tauri::command]
fn read_git_status(repo: String) -> Result<serde_json::Value, String> {
    let output = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(&repo)
        .output()
        .map_err(|e| format!("git status failed: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let changed_files: usize = stdout.lines().filter(|l| !l.is_empty()).count();
    Ok(serde_json::json!({ "changedFiles": changed_files, "clean": changed_files == 0 }))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build());

    // MCP plugin: exposes app to AI agents (screenshots, DOM, input simulation)
    // Only enabled in debug builds — strip from production
    #[cfg(debug_assertions)]
    {
        builder = builder.plugin(tauri_plugin_mcp::init_with_config(
            tauri_plugin_mcp::PluginConfig::new("o8".to_string())
                .start_socket_server(true)
                .socket_path("/tmp/tauri-mcp-o8.sock".into()),
        ));
    }

    builder
        .invoke_handler(tauri::generate_handler![
            get_desktop_info,
            check_port,
            start_ws_server,
            cortex_available,
            get_app_data_dir,
            read_repos,
            read_local_commits,
            read_worktrees,
            read_current_branch,
            read_git_status,
        ])
        .setup(|app| {
            // ── System Tray ──
            let show = MenuItem::with_id(app, "show", "Show Cortex IDE", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            let _tray = TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("Cortex IDE")
                .on_menu_event(|app, event| {
                    match event.id.as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            // ── Window Close → Hide to Tray ──
            let app_handle = app.handle().clone();
            if let Some(window) = app.get_webview_window("main") {
                #[cfg(target_os = "macos")]
                if let Err(err) =
                    apply_vibrancy(&window, NSVisualEffectMaterial::HudWindow, None, None)
                {
                    log::warn!("Failed to apply macOS vibrancy: {}", err);
                }

                #[cfg(target_os = "windows")]
                if let Err(err) = apply_blur(&window, Some((24, 26, 30, 168))) {
                    log::warn!("Failed to apply Windows blur: {}", err);
                }

                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        // Hide instead of close — agents keep working
                        api.prevent_close();
                        if let Some(w) = app_handle.get_webview_window("main") {
                            let _ = w.hide();
                        }
                        let _ = app_handle.emit("window-hidden", ());
                    }
                });
            }

            // ── Start bundled Next.js server ──
            // Skip if port 3001 is already bound (beforeDevCommand started dev servers)
            let resource_dir = app.path().resource_dir().expect("failed to resolve resource dir");
            let server_dir = resource_dir.join("server");
            let server_js = server_dir.join("server.js");
            let dev_server_running = std::net::TcpStream::connect("127.0.0.1:3001").is_ok();

            if dev_server_running {
                log::info!("Dev server already running on :3001 — skipping bundled servers");
            } else if server_js.exists() {
                // Use system Node.js (prerequisite)
                let node_bin = "node".to_string();

                // Set Cortex binary path if bundled
                let cortex_bin = server_dir.join("bin").join("cortex");
                if cortex_bin.exists() {
                    std::env::set_var("CORTEX_BINARY", &cortex_bin);
                    log::info!("Bundled cortex binary at {:?}", cortex_bin);
                }

                log::info!("Starting server: {} {:?}", node_bin, server_js);
                match Command::new(&node_bin)
                    .arg(&server_js)
                    .current_dir(&server_dir)
                    .env("PORT", "3001")
                    .env("HOSTNAME", "127.0.0.1")
                    .env("NODE_ENV", "production")
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::piped())
                    .spawn()
                {
                    Ok(child) => {
                        log::info!("Next.js server started (pid: {})", child.id());
                    }
                    Err(e) => {
                        log::error!("Failed to start server: {}. Is Node.js installed?", e);
                    }
                }
            } else {
                log::warn!("No bundled server found at {:?} — running in dev mode", server_js);
            }

            // ── Start WebSocket server (terminals, chat, git watcher) ──
            let ws_server = server_dir.join("ws-server.mjs");
            if !dev_server_running && ws_server.exists() {
                let ws_node = "node".to_string();
                log::info!("Starting WS server: {} {:?}", ws_node, ws_server);
                match Command::new(&ws_node)
                    .arg(&ws_server)
                    .current_dir(&server_dir)
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn()
                {
                    Ok(child) => {
                        log::info!("WS server started (pid: {})", child.id());
                    }
                    Err(e) => {
                        log::error!("Failed to start WS server: {}", e);
                    }
                }
            }

            log::info!("Cortex IDE desktop shell initialized");

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Cortex IDE");
}
