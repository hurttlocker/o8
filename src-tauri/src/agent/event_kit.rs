//! Native EventKit calendar read — the fast path for "what's on my calendar".
//!
//! The previous JXA `whose`-clause scan went through Apple Events and took
//! 27 seconds on a real 14-calendar set (the 30s osascript cap made the
//! single most common assistant ask effectively dead). The indexed EventKit
//! store answers the same query in milliseconds, and the permission prompt
//! attributes to o8 itself (NSCalendarsFullAccessUsageDescription in
//! Info.plist — required, the app aborts on prompt without it).
//!
//! Event CREATION stays on AppleScript (it works and shows up in Calendar.app
//! immediately); only the read path lives here.

use block2::RcBlock;
use objc2::runtime::Bool;
use objc2_event_kit::{EKAuthorizationStatus, EKEntityType, EKEventStore};
use objc2_foundation::{NSDate, NSError};
use std::sync::mpsc;

pub struct EventRow {
    pub id: String,
    pub title: String,
    pub start_local: String,
    pub end_local: String,
    pub start_epoch_ms: i64,
    pub end_epoch_ms: i64,
    pub calendar: String,
    pub all_day: bool,
}

/// Epoch seconds → local-time ISO string (the model speaks local times).
fn local_iso(ts: f64) -> String {
    use chrono::TimeZone;
    chrono::Local
        .timestamp_opt(ts as i64, 0)
        .single()
        .map(|d| d.format("%Y-%m-%dT%H:%M:%S").to_string())
        .unwrap_or_default()
}

/// Block until the user answers the Calendar full-access prompt (or it was
/// already decided). EventKit fires the completion on a background queue, so
/// a channel bridges it back — this is exactly why the JXA attempt hung: a
/// background-queue block can never re-enter osascript's JS thread.
fn request_full_access(store: &EKEventStore) -> Result<bool, String> {
    let (tx, rx) = mpsc::channel::<bool>();
    let block = RcBlock::new(move |granted: Bool, err: *mut NSError| {
        if !err.is_null() {
            let desc = unsafe { (*err).localizedDescription() };
            log::warn!("[event-kit] access request error: {desc}");
        }
        let _ = tx.send(granted.as_bool());
    });
    let block_ptr = (&*block as *const block2::Block<dyn Fn(Bool, *mut NSError)>).cast_mut();
    unsafe { store.requestFullAccessToEventsWithCompletion(block_ptr) };
    rx.recv_timeout(std::time::Duration::from_secs(120))
        .map_err(|_| "The Calendar permission dialog is still waiting — answer it and ask again.".to_string())
}

/// Upcoming events in the next `days` days, soonest first, capped at 20.
/// `calendar_filter` (case-insensitive calendar name) narrows when non-empty.
fn list_events_inner(
    days: i64,
    calendar_filter: &str,
    request_access: bool,
) -> Result<Option<Vec<EventRow>>, String> {
    unsafe {
        let store = EKEventStore::new();
        let status = EKEventStore::authorizationStatusForEntityType(EKEntityType::Event);
        let authorized = match status {
            EKAuthorizationStatus::FullAccess => true,
            EKAuthorizationStatus::NotDetermined | EKAuthorizationStatus::WriteOnly => {
                request_access && request_full_access(&store)?
            }
            _ => false,
        };
        if !authorized {
            if !request_access {
                return Ok(None);
            }
            return Err(
                "o8 doesn't have Calendar access — System Settings, Privacy and Security, \
                 Calendars, allow o8 full access, then ask again."
                    .into(),
            );
        }

        let start = NSDate::now();
        let end = NSDate::dateWithTimeIntervalSinceNow(days as f64 * 86_400.0);
        let predicate =
            store.predicateForEventsWithStartDate_endDate_calendars(&start, &end, None);
        let events = store.eventsMatchingPredicate(&predicate);

        let needle = calendar_filter.trim().to_lowercase();
        let mut rows: Vec<EventRow> = Vec::new();
        for event in events.iter() {
            let calendar = event
                .calendar()
                .map(|c| c.title().to_string())
                .unwrap_or_default();
            if !needle.is_empty() && calendar.to_lowercase() != needle {
                continue;
            }
            let start_ts = event.startDate().timeIntervalSince1970();
            let end_ts = event.endDate().timeIntervalSince1970();
            rows.push(EventRow {
                id: event
                    .eventIdentifier()
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| event.calendarItemIdentifier().to_string()),
                title: event.title().to_string(),
                start_local: local_iso(start_ts),
                end_local: local_iso(end_ts),
                start_epoch_ms: (start_ts * 1_000.0) as i64,
                end_epoch_ms: (end_ts * 1_000.0) as i64,
                calendar,
                all_day: event.isAllDay(),
            });
        }
        rows.sort_by(|a, b| a.start_local.cmp(&b.start_local));
        rows.truncate(20);
        Ok(Some(rows))
    }
}

pub fn list_events(days: i64, calendar_filter: &str) -> Result<Vec<EventRow>, String> {
    list_events_inner(days, calendar_filter, true)?.ok_or_else(|| {
        "o8 doesn't have Calendar access — allow full access, then ask again.".to_string()
    })
}

/// Background attention checks must never manufacture a permission prompt.
/// `None` means Calendar read access is not already granted.
pub fn list_events_if_authorized(
    days: i64,
    calendar_filter: &str,
) -> Result<Option<Vec<EventRow>>, String> {
    list_events_inner(days, calendar_filter, false)
}
