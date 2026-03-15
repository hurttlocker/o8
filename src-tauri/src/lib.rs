use serde::Serialize;
use std::process::Command;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            get_desktop_info,
            check_port,
            start_ws_server,
            cortex_available,
            get_app_data_dir,
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

            log::info!("Cortex IDE desktop shell initialized");

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Cortex IDE");
}
