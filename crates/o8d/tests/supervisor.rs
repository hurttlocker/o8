#![cfg(all(target_os = "linux", feature = "experimental-supervisor"))]

use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write},
    os::unix::{fs::PermissionsExt, net::UnixStream},
    process::{Command, Stdio},
    time::Duration,
};

#[test]
fn real_binary_owns_replays_and_reaps_a_worker_without_server_stdin() {
    let root = std::env::temp_dir().join(format!("o8d-supervisor-test-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
    let socket = root.join("control.sock");
    let mut daemon = Command::new(env!("CARGO_BIN_EXE_o8d"))
        .args(["--experimental-supervisor", "--socket"])
        .arg(&socket)
        .arg("--state-dir")
        .arg(&root)
        .env(
            "O8D_SUPERVISOR_TOKEN",
            "fixture-supervisor-authentication-value",
        )
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut ready = String::new();
        BufReader::new(daemon.stdout.take().unwrap())
            .read_line(&mut ready)
            .unwrap();
        assert!(
            !ready.is_empty(),
            "supervisor must accept explicit opt-in and stay alive without app stdin"
        );
        let call = |mut request: Value| -> Value {
            request["version"] = json!(1);
            if request.get("token").is_none() {
                request["token"] = json!("fixture-supervisor-authentication-value");
            }
            if request["op"] == "signal" && request.get("epoch").is_none() {
                let saved = root.join(format!("{}.owner.json", request["id"].as_str().unwrap()));
                request["epoch"] = std::fs::read(&saved)
                    .ok()
                    .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
                    .map(|v| v["epoch"].clone())
                    .unwrap_or(Value::Null);
            }
            let mut stream = UnixStream::connect(&socket).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            writeln!(stream, "{request}").unwrap();
            let mut line = String::new();
            BufReader::new(stream).read_line(&mut line).unwrap();
            serde_json::from_str(&line).unwrap()
        };
        let spawn = call(
            json!({"op":"spawn", "id":"fixture-run", "owner":"fixture-surface", "command":"/bin/sh",
            "args":["-c", "printf 'first'; sleep 0.1; printf 'last'; exit 7"], "env":{}, "cwd":root,
            "stdoutPath":root.join("stdout"), "stderrPath":root.join("stderr")}),
        );
        assert_eq!(spawn["ok"], true);
        let mut final_reply = Value::Null;
        for _ in 0..100 {
            final_reply = call(
                json!({"op":"attach", "id":"fixture-run", "owner":"fixture-surface", "since":0}),
            );
            if final_reply["state"] == "exited" {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(final_reply["state"], "exited");
        let events = final_reply["events"].as_array().unwrap();
        assert_eq!(events.iter().filter(|e| e["stream"] == "exit").count(), 1);
        assert_eq!(events.last().unwrap()["code"], 7);
        assert_eq!(
            std::fs::read_to_string(root.join("stdout")).unwrap(),
            "firstlast"
        );
        let replay = call(
            json!({"op":"attach", "id":"fixture-run", "owner":"fixture-surface", "since":final_reply["cursor"]}),
        );
        assert_eq!(replay["events"], json!([]));
        assert_eq!(
            call(
                json!({"op":"signal", "id":"fixture-run", "owner":"fixture-surface", "signal":"SIGKILL"})
            )["ok"],
            false
        );
        assert_eq!(
            call(
                json!({"op":"attach", "id":"fixture-run", "owner":"fixture-surface", "since":0, "token":"wrong-fixture-credential"})
            )["error"],
            "unauthorized"
        );
        assert_eq!(
            call(json!({"op":"attach", "id":"fixture-run", "owner":"foreign-surface", "since":0}))
                ["error"],
            "ownership-mismatch"
        );
        assert_eq!(
            call(
                json!({"op":"attach", "id":"fixture-run", "owner":"fixture-surface", "since":9999})
            )["error"],
            "invalid-cursor"
        );

        // Exercise identity refusal through the authenticated socket and actual
        // persisted record, including a foreign-pid substitution and a symlink.
        let running = call(
            json!({"op":"spawn", "id":"signal-run", "owner":"fixture-surface", "command":"/bin/sh",
            "args":["-c", "/bin/sleep 10 & printf '%s' $!; wait"], "env":{}, "cwd":root,
            "stdoutPath":root.join("group-output"), "stderrPath":root.join("group-error")}),
        );
        assert_eq!(running["ok"], true);
        let path = root.join("signal-run.owner.json");
        let original = std::fs::read(&path).unwrap();
        let mut record: Value = serde_json::from_slice(&original).unwrap();
        let signal = || {
            call(
                json!({"op":"signal", "id":"signal-run", "owner":"fixture-surface", "signal":"SIGTERM"}),
            )
        };
        record["identity"]["startId"] = json!("reused-pid-cookie");
        std::fs::write(&path, record.to_string()).unwrap();
        assert_eq!(signal()["ok"], false);
        record["pid"] = json!(std::process::id());
        std::fs::write(&path, record.to_string()).unwrap();
        assert_eq!(signal()["ok"], false);
        std::fs::remove_file(&path).unwrap();
        assert_eq!(signal()["ok"], false);
        std::os::unix::fs::symlink(root.join("fixture-run.owner.json"), &path).unwrap();
        assert_eq!(signal()["ok"], false);
        std::fs::remove_file(&path).unwrap();
        std::fs::write(&path, &original).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(std::path::Path::new(&format!("/proc/{}", running["pid"])).exists());
        assert_eq!(signal()["ok"], true);
        for _ in 0..100 {
            if call(json!({"op":"attach", "id":"signal-run", "owner":"fixture-surface", "since":0}))
                ["state"]
                == "exited"
            {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(signal()["ok"], false);

        let flood = call(
            json!({"op":"spawn", "id":"flood-run", "owner":"fixture-surface", "command":"/usr/bin/head",
            "args":["-c", "2097152", "/dev/zero"], "env":{}, "cwd":root,
            "stdoutPath":root.join("flood-output"), "stderrPath":root.join("flood-error")}),
        );
        assert_eq!(flood["ok"], true);
        let mut flood_reply = Value::Null;
        for _ in 0..100 {
            flood_reply = call(
                json!({"op":"attach", "id":"flood-run", "owner":"fixture-surface", "since":0}),
            );
            if flood_reply["state"] == "exited" {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(flood_reply["state"], "exited");
        assert_eq!(flood_reply["gap"], true);
        use base64::Engine;
        let bytes: usize = flood_reply["events"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|e| e["data"].as_str())
            .map(|data| {
                base64::engine::general_purpose::STANDARD
                    .decode(data)
                    .unwrap()
                    .len()
            })
            .sum();
        assert!(bytes <= 1024 * 1024);
        assert_eq!(
            std::fs::metadata(root.join("flood-output")).unwrap().len(),
            2 * 1024 * 1024
        );
        assert_eq!(
            flood_reply["events"].as_array().unwrap().last().unwrap()["code"],
            0
        );

        // Rapid exits and concurrent attach must not expose a reaped leader as
        // an unverifiable live owner between wait and terminal settlement.
        for index in 0..40 {
            let run_id = format!("quick-{index}");
            assert_eq!(
                call(
                    json!({"op":"spawn", "id":run_id, "owner":"fixture-surface", "command":"/bin/true",
                "args":[], "env":{}, "cwd":root,
                "stdoutPath":root.join("quick-output"), "stderrPath":root.join("quick-error")})
                )["ok"],
                true
            );
            let mut exited = false;
            for _ in 0..500 {
                let reply =
                    call(json!({"op":"attach", "id":run_id, "owner":"fixture-surface", "since":0}));
                assert_eq!(reply["ok"], true, "rapid exit must remain attachable");
                if reply["state"] == "exited" {
                    exited = true;
                    break;
                }
            }
            assert!(exited);
        }

        // Restarting the supervisor preserves terminal receipts without granting
        // authority over a foreign process from any old running record.
        daemon.kill().unwrap();
        daemon.wait().unwrap();
        daemon = Command::new(env!("CARGO_BIN_EXE_o8d"))
            .args(["--experimental-supervisor", "--socket"])
            .arg(&socket)
            .arg("--state-dir")
            .arg(&root)
            .env(
                "O8D_SUPERVISOR_TOKEN",
                "fixture-supervisor-authentication-value",
            )
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut ready = String::new();
        BufReader::new(daemon.stdout.take().unwrap())
            .read_line(&mut ready)
            .unwrap();
        assert!(!ready.is_empty());
        let restored =
            call(json!({"op":"attach", "id":"fixture-run", "owner":"fixture-surface", "since":0}));
        assert_eq!(
            restored["events"].as_array().unwrap().last().unwrap(),
            events.last().unwrap()
        );
        assert_eq!(signal()["ok"], false);
    }));
    let _ = daemon.kill();
    let _ = daemon.wait();
    let _ = std::fs::remove_dir_all(root);
    if let Err(error) = result {
        std::panic::resume_unwind(error);
    }
}
