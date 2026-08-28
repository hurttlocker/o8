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
    let defaults = super::o8_http::get_json("/api/panel/operator-defaults").await?;
    let Some((enabled, lead_minutes)) = settings(&defaults) else {
        return Err("operator defaults response omitted Calendar attention settings".into());
    };
    if !enabled {
        return Ok(());
    }

    let rows = tokio::task::spawn_blocking(|| {
        super::event_kit::list_events_if_authorized(1, "")
    })
    .await
    .map_err(|error| format!("calendar attention worker failed: {error}"))??;
    let Some(rows) = rows else {
        return Ok(());
    };

    let now_ms = chrono::Utc::now().timestamp_millis();
    let lead_ms = lead_minutes * 60_000;
    for row in rows.into_iter().filter(|row| {
        !row.all_day
            && row.start_epoch_ms > now_ms
            && row.start_epoch_ms <= now_ms + lead_ms
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
    use super::settings;
    use serde_json::json;

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
