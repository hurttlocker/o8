//! `symon_watch_run` enters the governed plan executor.
//!
//! The durable watch row is o8's; what has to be proven natively is that the
//! saved body reaches `plan::execute_plan`, that the confirmation card is
//! requested with the condition and the full step read-back, and that a refused
//! card runs nothing and settles the watch as denied.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::mpsc;

use serde_json::{json, Value};

use super::{plan, store, TaskCtx};

struct FakeO8 {
    port: u16,
    requests: mpsc::Receiver<(String, String)>,
}

/// A bounded stand-in for o8's loopback API: it answers the two calls the run
/// path makes and reports exactly what it was asked.
fn fake_o8(plan_body: Value) -> FakeO8 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind fake o8");
    let port = listener.local_addr().expect("fake o8 addr").port();
    let (sender, requests) = mpsc::channel();
    std::thread::spawn(move || {
        for _ in 0..2 {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            let mut reader = BufReader::new(stream.try_clone().expect("clone stream"));
            let mut request_line = String::new();
            if reader.read_line(&mut request_line).is_err() {
                return;
            }
            let mut content_length = 0usize;
            loop {
                let mut header = String::new();
                if reader.read_line(&mut header).is_err() || header.trim().is_empty() {
                    break;
                }
                if let Some(value) = header.to_lowercase().strip_prefix("content-length:") {
                    content_length = value.trim().parse().unwrap_or(0);
                }
            }
            let mut body = vec![0u8; content_length];
            if content_length > 0 && reader.read_exact(&mut body).is_err() {
                return;
            }
            let _ = sender.send((
                request_line.trim().to_string(),
                String::from_utf8_lossy(&body).to_string(),
            ));
            let payload = if request_line.starts_with("GET") {
                plan_body.to_string()
            } else {
                json!({ "watch": { "id": "watch_test", "state": "closed" } }).to_string()
            };
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
                payload.len()
            );
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.flush();
        }
    });
    FakeO8 { port, requests }
}

fn watch_ctx() -> TaskCtx {
    TaskCtx {
        task_id: "watch-run-test".into(),
        utterance: "run that watch".into(),
        ledger_session_id: Some("watch-session".into()),
        machine_session_id: "desktop".into(),
        // No desktop handle means the card cannot be shown, which is exactly
        // how a refused card behaves: fail closed, run nothing.
        app: None,
        screen: None,
        spatial: false,
        crop_png_base64: None,
        edit: None,
        cancel: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        escalate_available: false,
    }
}

fn plan_events(data_dir: &std::path::Path) -> Vec<(String, String, String)> {
    let conn = rusqlite::Connection::open(data_dir.join("agent.db")).expect("open agent.db");
    let mut statement = conn
        .prepare("SELECT phase, redacted_summary, outcome FROM agent_plan_events ORDER BY seq ASC")
        .expect("prepare plan events");
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .expect("query plan events");
    rows.map(|row| row.expect("read plan event")).collect()
}

#[test]
fn a_refused_card_runs_no_step_and_settles_the_watch_as_denied() {
    let data_dir = std::env::temp_dir().join(format!("o8-watch-run-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data_dir);
    std::fs::create_dir_all(&data_dir).expect("create test data dir");

    let fake = fake_o8(json!({
        "watch": { "id": "watch_test" },
        "plan": {
            "condition": "tell me when the checks finish",
            "steps": [{ "tool": "mac_reminders_create", "args": { "title": "ship the review" } }],
        },
        "planError": null,
    }));
    std::env::set_var("O8_API_PORT", fake.port.to_string());

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("build runtime");
    let result = store::with_test_data_dir(data_dir.clone(), || {
        runtime.block_on(plan::execute_watch_run(
            &watch_ctx(),
            json!({ "id": "watch_test" }),
            false,
            None,
            "watch_run_test",
            Some("run that watch"),
            None,
        ))
    });

    assert_eq!(result.get("ok"), Some(&Value::Bool(false)), "{result}");
    assert_eq!(
        result.get("declined_by_user"),
        Some(&Value::Bool(true)),
        "{result}"
    );
    assert_eq!(
        result.get("watchOutcome").and_then(Value::as_str),
        Some("denied")
    );
    assert_eq!(
        result.get("watchId").and_then(Value::as_str),
        Some("watch_test")
    );

    // The body was CLAIMED, not merely read, and the refusal was written back.
    let (claim_line, _) = fake.requests.recv().expect("claim request");
    assert!(
        claim_line.contains("/api/symon/watches/watch_test?claim=1"),
        "{claim_line}"
    );
    let (settle_line, settle_body) = fake.requests.recv().expect("settle request");
    assert!(settle_line.starts_with("PATCH"), "{settle_line}");
    assert!(settle_body.contains("\"runOutcome\":\"denied\""), "{settle_body}");

    // The card was requested with the condition AND the full step read-back,
    // and no step ever started.
    let events = plan_events(&data_dir);
    let proposed = events
        .iter()
        .find(|(phase, _, _)| phase == "proposed")
        .expect("the plan was proposed to the operator");
    assert!(
        proposed.1.contains("tell me when the checks finish"),
        "the card must name the standing intent that fired: {}",
        proposed.1
    );
    assert!(
        proposed.1.contains("ship the review"),
        "the card must read the saved step back: {}",
        proposed.1
    );
    assert!(
        events.iter().any(|(phase, _, _)| phase == "rejected"),
        "the refusal is a durable checkpoint: {events:?}"
    );
    assert!(
        !events.iter().any(|(phase, _, _)| phase == "step_running"),
        "a refused card runs nothing: {events:?}"
    );

    std::env::remove_var("O8_API_PORT");
    let _ = std::fs::remove_dir_all(&data_dir);
}

#[test]
fn a_saved_body_reads_back_the_same_way_a_live_plan_does() {
    let steps = vec![json!({ "tool": "mac_reminders_create", "args": { "title": "ship the review" } })];
    let readback = plan::watch_body_readback(&steps).expect("a valid body reads back");
    assert!(readback.starts_with("1. "), "{readback}");
    assert!(readback.contains("ship the review"), "{readback}");

    // A body that could never run is refused at registration, not at 3am.
    let nested = plan::watch_body_readback(&[json!({ "tool": "symon_watch_run", "args": { "id": "w" } })]);
    assert!(nested.unwrap_err().contains("control tool"));
    let unknown = plan::watch_body_readback(&[json!({ "tool": "not_a_tool", "args": {} })]);
    assert!(unknown.unwrap_err().contains("unknown tool"));
}
