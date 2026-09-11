//! Per-session planner seat handles for the bound text surface (#2176).
//!
//! ## Why a handle at all
//! The bound surface (phone Symon, managed messages) used to name its seat by
//! an `(engine, model, effort)` triple, so a registry entry whose model comes
//! from the runtime's own configuration had nothing to be named by. Seat
//! identity is really the registry entry id; what makes a seat *resumable* is
//! an opaque handle whose shape belongs to the adapter, not to o8:
//!
//! | seat | handle |
//! |---|---|
//! | opencode | the `sessionID` its first `run` reports, replayed as `--session <id>` |
//! | codex | the thread id `exec` reports, replayed as `exec resume <id>` |
//! | claude | the resident `stream-json` child's session key |
//!
//! Only the open seat resumes through this store today. The other two are
//! already named by an o8-side model id and keep their per-turn spawn — holding
//! a resident child or a Codex thread across bound turns is a process-lifetime
//! change this issue does not need, and #2176 requires the default path to stay
//! byte-identical.
//!
//! ## Where the handle lives
//! Native-side, keyed by the bound surface's own text session id, which every
//! turn already carries. The handle never crosses the bridge: it is the
//! adapter's private token, and a phone has no business holding one. A stored
//! handle is fenced by the engine that produced it, so a seat change mid
//! conversation starts a new thread instead of replaying someone else's.

use std::sync::Mutex;

/// Conversations tracked at once. The bound surface is a single operator's
/// phone and message threads, so this is generous; the oldest entry is dropped
/// rather than letting a long-lived process grow without bound.
const MAX_TRACKED_SESSIONS: usize = 64;

/// `(text session id, engine id, opaque handle)`, most recently used first.
static SEATS: Mutex<Vec<(String, &'static str, String)>> = Mutex::new(Vec::new());

fn seats() -> std::sync::MutexGuard<'static, Vec<(String, &'static str, String)>> {
    SEATS.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The handle this text session opened on `engine`, or `None` when it has none
/// — a first turn, or a session whose last turn ran on a different seat.
pub(crate) fn handle_for(session_id: &str, engine: &str) -> Option<String> {
    seats()
        .iter()
        .find(|(id, seat, _)| id == session_id && *seat == engine)
        .map(|(_, _, handle)| handle.clone())
}

/// Remember what the turn ended on so the next turn resumes it. Replaces any
/// handle already held for this session, including one from another seat.
pub(crate) fn remember(session_id: &str, engine: &'static str, handle: String) {
    if handle.trim().is_empty() {
        return;
    }
    let mut seats = seats();
    seats.retain(|(id, _, _)| id != session_id);
    seats.insert(0, (session_id.to_string(), engine, handle));
    seats.truncate(MAX_TRACKED_SESSIONS);
}

#[cfg(test)]
pub(crate) fn reset() {
    seats().clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The store is process-global, so these serialize against each other.
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn exclusive() -> std::sync::MutexGuard<'static, ()> {
        let guard = TEST_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        reset();
        guard
    }

    #[test]
    fn a_handle_is_fenced_by_the_seat_that_produced_it() {
        let _guard = exclusive();
        remember("session-a", "opencode", "ses_one".to_string());
        assert_eq!(handle_for("session-a", "opencode").as_deref(), Some("ses_one"));
        // Same conversation, different seat: no handle, so the turn opens its
        // own thread rather than replaying another runtime's id.
        assert_eq!(handle_for("session-a", "codex"), None);
        assert_eq!(handle_for("session-b", "opencode"), None);

        // A seat change replaces the entry rather than stacking a second one.
        remember("session-a", "codex", "thread_two".to_string());
        assert_eq!(handle_for("session-a", "opencode"), None);
        assert_eq!(handle_for("session-a", "codex").as_deref(), Some("thread_two"));
        assert_eq!(seats().len(), 1);
    }

    #[test]
    fn the_store_is_bounded_and_drops_the_oldest_conversation() {
        let _guard = exclusive();
        for index in 0..(MAX_TRACKED_SESSIONS + 5) {
            remember(&format!("session-{index}"), "opencode", format!("ses_{index}"));
        }
        assert_eq!(seats().len(), MAX_TRACKED_SESSIONS);
        assert_eq!(handle_for("session-0", "opencode"), None);
        let newest = MAX_TRACKED_SESSIONS + 4;
        assert_eq!(
            handle_for(&format!("session-{newest}"), "opencode").as_deref(),
            Some(format!("ses_{newest}").as_str())
        );
    }

    #[test]
    fn an_empty_handle_is_never_stored() {
        let _guard = exclusive();
        remember("session-empty", "opencode", "   ".to_string());
        assert_eq!(handle_for("session-empty", "opencode"), None);
    }
}
