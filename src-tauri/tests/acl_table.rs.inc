use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::ipc::{Origin, RuntimeAuthority};

fn decision_digest(authority: &RuntimeAuthority, table: &Value) -> (String, usize, usize) {
    let mut digest = Sha256::new();
    let mut rows = 0;
    let mut allowed = 0;
    for command in table["commands"].as_array().unwrap() {
        let command = command.as_str().unwrap();
        for pair in table["windowWebview"].as_array().unwrap() {
            let window = pair[0].as_str().unwrap();
            let webview = pair[1].as_str().unwrap();
            for url in table["origins"].as_array().unwrap() {
                let origin = match url.as_str() {
                    Some(url) => Origin::Remote {
                        url: url.parse().unwrap(),
                    },
                    None => Origin::Local,
                };
                let decision = authority
                    .resolve_access(command, window, webview, &origin)
                    .is_some();
                digest.update(
                    serde_json::to_vec(&(command, window, webview, url, decision)).unwrap(),
                );
                digest.update(b"\n");
                rows += 1;
                allowed += usize::from(decision);
            }
        }
    }
    (format!("{:x}", digest.finalize()), rows, allowed)
}
