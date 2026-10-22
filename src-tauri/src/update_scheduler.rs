//! Native schedule and server handoff. No webview, React mount, or JS timer is needed.
#[path = "update_schedule.rs"]
mod schedule;
use schedule::UpdateSchedule;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Runtime};

static WOKE: AtomicBool = AtomicBool::new(false);

pub fn observe_wake() {
    #[cfg(target_os = "macos")]
    unsafe {
        use objc2_app_kit::{NSWorkspace, NSWorkspaceDidWakeNotification};
        use objc2_foundation::NSNotification;
        let block = block2::RcBlock::new(|_: std::ptr::NonNull<NSNotification>| {
            WOKE.store(true, Ordering::Release);
        });
        let observer = NSWorkspace::sharedWorkspace()
            .notificationCenter()
            .addObserverForName_object_queue_usingBlock(
                Some(NSWorkspaceDidWakeNotification),
                None,
                None,
                &block,
            );
        // The scheduler and this one observer live for the entire application process.
        std::mem::forget(observer);
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub async fn run<R: Runtime>(app: AppHandle<R>) {
    let client = match reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(2))
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            log::error!("[updater] state transport unavailable: {error}");
            return;
        }
    };
    let mut schedule = UpdateSchedule::default();
    let mut report: Option<serde_json::Value> = None;
    let mut served_request = String::new();
    loop {
        // Boot starts before port allocation. Never fall back to another running server.
        let url = std::env::var("O8_API_PORT")
            .ok()
            .and_then(|port| port.parse::<u16>().ok())
            .map(|port| format!("http://127.0.0.1:{port}/api/panel/app/update-state"));
        let token = crate::resolve_ws_token();
        let control = if let Some(url) = &url {
            match client.get(url).bearer_auth(&token).send().await {
                Ok(response) if response.status().is_success() => {
                    response.json::<serde_json::Value>().await.ok()
                }
                _ => None,
            }
        } else {
            None
        };
        let request = control
            .as_ref()
            .and_then(|v| v["checkRequestedAt"].as_str())
            .unwrap_or_default();
        if schedule.due(
            now_ms(),
            WOKE.swap(false, Ordering::AcqRel)
                || (!request.is_empty() && request != served_request),
        ) {
            report = Some(super::run_check(&app).await);
            served_request = request.to_string();
            // Checking the network can itself take seconds. That is not a sleep/wake gap.
            schedule.completed(now_ms());
        }
        if let (Some(url), Some(report)) = (&url, &report) {
            let recorded = control
                .as_ref()
                .and_then(|v| v["state"]["check"]["checkedAt"].as_str());
            if recorded < report["checkedAt"].as_str() {
                // Retry the retained report after startup or server replacement, even without UI.
                let _ = client
                    .post(url)
                    .bearer_auth(&token)
                    .json(report)
                    .send()
                    .await;
            }
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}
