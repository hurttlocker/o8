//! Permission-safe Calendar → durable Broadcast attention bridge.
//!
//! The poller never speaks and never requests Calendar access. It only submits
//! already-authorized imminent events to the local o8 API. The Broadcast
//! speaker owns quiet hours, subscriptions, the rolling budget, deduplication,
//! and durable provenance.

use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

const POLL_INTERVAL: Duration = Duration::from_secs(60);
const INITIAL_DELAY: Duration = Duration::from_secs(10);
static STARTED: AtomicBool = AtomicBool::new(false);

fn settings(payload: &Value) -> Option<(bool, i64)> {
    let values = payload.get("values")?;
    let enabled = values.get("broadcastVoice")?.as_str() == Some("on")
        && values.get("broadcastVoiceCalendar")?.as_bool() == Some(true);
    let lead_minutes = values
        .get("broadcastVoiceCalendarLeadMinutes")
        .and_then(Value::as_i64)
        .unwrap_or(15)
        .clamp(1, 1_440);
    Some((enabled, lead_minutes))
}

async fn poll_once() -> Result<(), String> {
    // This timer only reads settings. The full response also probes worker
    // authentication, even when Calendar attention is disabled.
    let defaults = super::o8_http::get_json("/api/panel/operator-defaults?include=values").await?;
    let Some((enabled, lead_minutes)) = settings(&defaults) else {
        return Err("operator defaults response omitted Calendar attention settings".into());
    };
    if !enabled {
        return Ok(());
    }

    let rows = tokio::task::spawn_blocking(|| super::event_kit::list_events_if_authorized(1, ""))
        .await
        .map_err(|error| format!("calendar attention worker failed: {error}"))??;
    let Some(rows) = rows else {
        return Ok(());
    };

    let now_ms = chrono::Utc::now().timestamp_millis();
    let lead_ms = lead_minutes * 60_000;
    for row in rows.into_iter().filter(|row| {
        !row.all_day && row.start_epoch_ms > now_ms && row.start_epoch_ms <= now_ms + lead_ms
    }) {
        let body = json!({
            "eventId": row.id,
            "title": row.title,
            "calendar": row.calendar,
            "startLocal": row.start_local,
            "endLocal": row.end_local,
            "startEpochMs": row.start_epoch_ms,
            "endEpochMs": row.end_epoch_ms,
            "allDay": row.all_day,
        });
        if let Err(error) = super::o8_http::post_json("/api/broadcast/calendar", body).await {
            log::debug!("[calendar-attention] local ingest skipped: {error}");
        }
    }
    Ok(())
}

pub fn spawn() {
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(INITIAL_DELAY).await;
        loop {
            if let Err(error) = poll_once().await {
                log::debug!("[calendar-attention] poll skipped: {error}");
            }
            tokio::time::sleep(POLL_INTERVAL).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{poll_once, settings};
    use serde_json::json;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::time::{Duration, Instant};

    struct HttpFixture {
        dir: std::path::PathBuf,
        previous: Vec<(&'static str, Option<std::ffi::OsString>)>,
    }

    impl Drop for HttpFixture {
        fn drop(&mut self) {
            for (name, value) in self.previous.drain(..) {
                match value {
                    Some(value) => std::env::set_var(name, value),
                    None => std::env::remove_var(name),
                }
            }
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn disabled_calendar_poll_reads_values_only_through_authenticated_http() {
        let _guard = crate::DATA_DIR_ENV_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let fixture = HttpFixture {
            dir: std::env::temp_dir().join(format!(
                "o8-calendar-http-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
            )),
            previous: ["O8_DATA_DIR", "O8_API_PORT"]
                .into_iter()
                .map(|name| (name, std::env::var_os(name)))
                .collect(),
        };
        std::fs::create_dir(&fixture.dir).unwrap();
        std::fs::write(fixture.dir.join("ws-token"), "calendar-fixture-token").unwrap();
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        std::env::set_var("O8_DATA_DIR", &fixture.dir);
        std::env::set_var(
            "O8_API_PORT",
            listener.local_addr().unwrap().port().to_string(),
        );
        let server = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(error)
                        if error.kind() == std::io::ErrorKind::WouldBlock
                            && Instant::now() < deadline =>
                    {
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    Err(error) => panic!("calendar test accept failed: {error}"),
                }
            };
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut request = String::new();
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap() == 0 || line == "\r\n" {
                    break;
                }
                request.push_str(&line);
                assert!(request.len() <= 8_192);
            }
            // A disabled setting must return before accessing native Calendar.
            let body = r#"{"values":{"broadcastVoice":"off","broadcastVoiceCalendar":true}}"#;
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
            request
        });
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let result = runtime.block_on(poll_once());
        let request = server.join().unwrap();
        assert!(result.is_ok(), "calendar poll failed: {result:?}");
        assert!(request.starts_with("GET /api/panel/operator-defaults?include=values HTTP/1.1\r\n"));
        assert!(request
            .to_ascii_lowercase()
            .contains("authorization: bearer calendar-fixture-token\r\n"));
    }

    #[test]
    fn settings_require_voice_and_calendar_subscription() {
        assert_eq!(
            settings(&json!({ "values": {
                "broadcastVoice": "on",
                "broadcastVoiceCalendar": true,
                "broadcastVoiceCalendarLeadMinutes": 20,
            }})),
            Some((true, 20)),
        );
        assert_eq!(
            settings(&json!({ "values": {
                "broadcastVoice": "off",
                "broadcastVoiceCalendar": true,
            }})),
            Some((false, 15)),
        );
    }
}
