//! A lost terminal failure acknowledgment must never repeat an install effect.
use crate::launch_updater::scheduler::auto_apply::{AutoApply, Effects};
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};

struct FailedInstall(Arc<AtomicUsize>);
impl Effects for FailedInstall {
    async fn install(&self, _: &str, _: &str) -> Result<bool, String> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Err("fixture install failed".into())
    }
    fn restart(&self) -> Result<(), String> {
        panic!("failed installation cannot restart")
    }
}

#[test]
fn lost_failure_acknowledgment_retries_only_the_report_then_requires_admission() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!(
        "http://{}/api/panel/app/update-state",
        listener.local_addr().unwrap()
    );
    let server = std::thread::spawn(move || {
        let mut actions = Vec::new();
        for index in 0..4 {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 4096];
            let split = loop {
                let count = stream.read(&mut buffer).unwrap();
                assert!(count > 0);
                request.extend_from_slice(&buffer[..count]);
                if let Some(index) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                    break index + 4;
                }
            };
            let headers = String::from_utf8_lossy(&request[..split]).to_lowercase();
            let length = headers
                .lines()
                .find_map(|line| line.strip_prefix("content-length: "))
                .unwrap()
                .parse::<usize>()
                .unwrap();
            while request.len() < split + length {
                let count = stream.read(&mut buffer).unwrap();
                assert!(count > 0);
                request.extend_from_slice(&buffer[..count]);
            }
            let body: serde_json::Value =
                serde_json::from_slice(&request[split..split + length]).unwrap();
            actions.push(body["autoApply"]["action"].as_str().unwrap().to_string());
            if index == 1 {
                continue;
            } // Server recorded failure, but its reply was lost.
            let reply = serde_json::json!({ "allowed": index == 0, "version": "0.2.0",
                "attemptId": body["autoApply"]["attemptId"] })
            .to_string();
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}", reply.len()).unwrap();
        }
        actions
    });
    let installs = Arc::new(AtomicUsize::new(0));
    let effects = FailedInstall(installs.clone());
    tauri::async_runtime::block_on(async {
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap();
        let mut automatic = AutoApply::new(Duration::ZERO);
        for _ in 0..3 {
            automatic.tick(&client, &url, "fixture", &effects).await;
        }
    });
    assert_eq!(installs.load(Ordering::SeqCst), 1);
    assert_eq!(
        server.join().unwrap(),
        vec!["admit", "failed", "failed", "admit"]
    );
}

struct BusyThenIdle {
    directory: std::path::PathBuf,
    calls: Arc<AtomicUsize>,
}
impl Effects for BusyThenIdle {
    fn data_directory(&self) -> Result<Option<std::path::PathBuf>, String> {
        Ok(Some(self.directory.clone()))
    }
    async fn install(&self, _: &str, _: &str) -> Result<bool, String> {
        Ok(self.calls.fetch_add(1, Ordering::SeqCst) > 0)
    }
    fn restart(&self) -> Result<(), String> {
        panic!("test server defers restart")
    }
}

#[test]
fn transient_busy_reports_wait_drops_owner_and_readmits_without_manual_retry() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().to_path_buf();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!(
        "http://{}/api/panel/app/update-state",
        listener.local_addr().unwrap()
    );
    let server = std::thread::spawn(move || {
        let mut actions = Vec::new();
        let mut ids = Vec::new();
        for index in 0..4 {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 4096];
            let split = loop {
                let n = stream.read(&mut buffer).unwrap();
                assert!(n > 0);
                request.extend_from_slice(&buffer[..n]);
                if let Some(i) = request.windows(4).position(|p| p == b"\r\n\r\n") {
                    break i + 4;
                }
            };
            let headers = String::from_utf8_lossy(&request[..split]).to_lowercase();
            let length = headers
                .lines()
                .find_map(|line| line.strip_prefix("content-length: "))
                .unwrap()
                .parse::<usize>()
                .unwrap();
            while request.len() < split + length {
                let n = stream.read(&mut buffer).unwrap();
                assert!(n > 0);
                request.extend_from_slice(&buffer[..n]);
            }
            let body: serde_json::Value =
                serde_json::from_slice(&request[split..split + length]).unwrap();
            let id = body["autoApply"]["attemptId"].as_str().unwrap().to_string();
            actions.push(body["autoApply"]["action"].as_str().unwrap().to_string());
            if index == 0 || index == 2 {
                ids.push(id.clone());
            }
            if index == 1 {
                let receipt: serde_json::Value = serde_json::from_slice(
                    &std::fs::read(root.join("native-update-tasks").join(format!("{id}.json")))
                        .unwrap(),
                )
                .unwrap();
                assert_eq!(
                    receipt["status"], "stopped",
                    "release only after the download unwinds"
                );
            }
            let reply = serde_json::json!({"allowed":index == 0 || index == 2,"version":"0.2.0","attemptId":id}).to_string();
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}", reply.len()).unwrap();
        }
        (actions, ids)
    });
    let effects = BusyThenIdle {
        directory: directory.path().to_path_buf(),
        calls: Arc::new(AtomicUsize::new(0)),
    };
    tauri::async_runtime::block_on(async {
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap();
        let mut automatic = AutoApply::new(Duration::ZERO);
        automatic.tick(&client, &url, "fixture", &effects).await;
        automatic.tick(&client, &url, "fixture", &effects).await;
    });
    let (actions, ids) = server.join().unwrap();
    assert_eq!(actions, ["admit", "wait", "admit", "restart"]);
    assert_ne!(ids[0], ids[1]);
    assert_eq!(effects.calls.load(Ordering::SeqCst), 2);
}
