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
