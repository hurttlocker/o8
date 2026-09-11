//! Presentation (quiet) mode — the native half of the "nothing appears over a
//! screen share" contract.
//!
//! o8 paints on more than one window. Besides `main` there are four
//! always-on-top satellite overlays (`dock`, `agent-partials`, `point-overlay`,
//! `spatial-ink`) and a native notification path (`notify_review_ready`). None
//! of them is reachable from the main window's document, so a surface checking
//! the app's own state cannot tell whether something is currently on screen in
//! front of an audience.
//!
//! Quiet mode is one switch that owns all of it:
//!   * every overlay window is hidden for the duration and cannot re-show,
//!   * native review notifications are suppressed,
//!   * leaving the mode restores exactly the overlays that were up.
//!
//! Everything here is written against the `OverlayControl` seam rather than
//! `tauri::WebviewWindow`, so the enter/exit bookkeeping and the notice
//! classifier are unit-testable with no display, no AppKit, and no window
//! server. `TauriOverlays` is the thin real implementation.

// Some variants and helpers exist for the classifier contract (and its
// cross-language parity test) rather than for a current call site.
#![allow(dead_code)]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::sync::OnceLock;

/// The four label-disciplined satellite webviews. Same list as
/// `capabilities/overlay-windows.json`; `main` is deliberately absent — quiet
/// mode never hides the app the operator is presenting.
pub const OVERLAY_LABELS: [&str; 4] = ["dock", "agent-partials", "point-overlay", "spatial-ink"];

/// Where a `MovedOffscreen` overlay parks. Far enough negative that no attached
/// display can contain it, close enough that a bad restore is still obvious in
/// a window dump rather than silently lost at i32::MIN.
pub const OFFSCREEN_ORIGIN: (i32, i32) = (-32_000, -32_000);

// ── The notice classifier ────────────────────────────────────────────────────
//
// CANONICAL DEFINITION OF "CRITICAL": a notice is critical when suppressing it
// could cost the operator work or leave them unaware that o8 is blocked —
// approvals waiting on a human, errors, and an update the app is about to
// apply. Everything else is a convenience surface and is suppressible.
//
// The same table is declared for the in-app surfaces in
// `src/lib/presentation/quiet-mode-policy.ts`; `tests/quiet-mode-policy-parity.test.ts`
// reads THIS file and fails if the two drift. Change both together.

/// Every notice o8 can raise, native or in-app.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NoticeKind {
    /// An approval is waiting on the operator. CRITICAL.
    Approval,
    /// Something failed. CRITICAL.
    Error,
    /// An update is ready to apply. CRITICAL.
    UpdateAvailable,
    /// A packet flipped to awaiting_review. Suppressible.
    ReviewReady,
    /// Guided-discovery / onboarding coachmark. Suppressible.
    CoachCard,
    /// A count pill (escalated / review / merge). Suppressible.
    StatusPill,
    /// A transient in-app toast. Suppressible.
    Toast,
    /// One of the always-on-top satellite windows. Suppressible.
    OverlayWindow,
}

impl NoticeKind {
    /// The wire name shared with the TypeScript policy table.
    pub fn as_str(self) -> &'static str {
        match self {
            NoticeKind::Approval => "approval",
            NoticeKind::Error => "error",
            NoticeKind::UpdateAvailable => "update-available",
            NoticeKind::ReviewReady => "review-ready",
            NoticeKind::CoachCard => "coach-card",
            NoticeKind::StatusPill => "status-pill",
            NoticeKind::Toast => "toast",
            NoticeKind::OverlayWindow => "overlay-window",
        }
    }
}

/// Whether quiet mode hides this notice. Critical notices always show — quiet
/// mode is about not embarrassing the operator, never about hiding that o8 is
/// blocked on them.
pub fn quiet_mode_suppresses(kind: NoticeKind) -> bool {
    !matches!(
        kind,
        NoticeKind::Approval | NoticeKind::Error | NoticeKind::UpdateAvailable
    )
}

// ── Overlay bookkeeping ──────────────────────────────────────────────────────

/// How an overlay was taken off screen, so exit can undo exactly that.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OverlayHideStrategy {
    /// `window.hide()`. Preferred: nothing paints, the frame keeps its geometry,
    /// and nothing has to be put back.
    Hidden,
    /// Parked at `OFFSCREEN_ORIGIN`. Only for a window that must stay mapped for
    /// an event tap; the pre-move position is recorded and restored on exit.
    MovedOffscreen,
}

/// One overlay's state at the moment quiet mode was entered.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OverlayState {
    pub label: String,
    pub visible: bool,
    /// Outer position in physical pixels when the snapshot was taken. `None`
    /// when the window server could not report one.
    pub position: Option<(i32, i32)>,
    pub strategy: OverlayHideStrategy,
}

/// The seam. The real implementation talks to Tauri; tests use a fake window
/// set, which is what makes the round-trip assertable without a display.
pub trait OverlayControl {
    /// Existing overlays only — a label with no live window is skipped.
    fn snapshot(&self) -> Vec<OverlayState>;
    fn hide(&mut self, label: &str);
    fn show(&mut self, label: &str);
    fn set_position(&mut self, label: &str, x: i32, y: i32);
}

/// Hide every currently visible overlay and return what to restore later.
///
/// Only VISIBLE overlays are recorded: an overlay the operator already had down
/// must stay down when quiet mode ends, so exit never resurrects it.
pub fn enter_quiet_mode<C: OverlayControl + ?Sized>(control: &mut C) -> Vec<OverlayState> {
    let mut saved = Vec::new();
    for state in control.snapshot() {
        if !state.visible {
            continue;
        }
        match state.strategy {
            OverlayHideStrategy::Hidden => control.hide(&state.label),
            OverlayHideStrategy::MovedOffscreen => {
                control.set_position(&state.label, OFFSCREEN_ORIGIN.0, OFFSCREEN_ORIGIN.1)
            }
        }
        saved.push(state);
    }
    saved
}

/// Put back exactly what `enter_quiet_mode` took away, in the same positions.
pub fn exit_quiet_mode<C: OverlayControl + ?Sized>(control: &mut C, saved: &[OverlayState]) {
    for state in saved {
        match state.strategy {
            OverlayHideStrategy::Hidden => {
                if let Some((x, y)) = state.position {
                    control.set_position(&state.label, x, y);
                }
                control.show(&state.label);
            }
            OverlayHideStrategy::MovedOffscreen => {
                if let Some((x, y)) = state.position {
                    control.set_position(&state.label, x, y);
                }
            }
        }
    }
}

// ── Process-wide mode state ──────────────────────────────────────────────────

static QUIET_MODE: AtomicBool = AtomicBool::new(false);
/// Mirrors the `notificationsReviewReady` operator default. Default ON so an
/// existing install behaves exactly as before until the operator opts out.
static REVIEW_NOTIFICATIONS: AtomicBool = AtomicBool::new(true);

fn saved_overlays() -> &'static Mutex<Vec<OverlayState>> {
    static SAVED: OnceLock<Mutex<Vec<OverlayState>>> = OnceLock::new();
    SAVED.get_or_init(|| Mutex::new(Vec::new()))
}

/// Queryable from Rust. The TS mirror is `presentation_quiet_mode_get`.
pub fn is_quiet_mode_active() -> bool {
    QUIET_MODE.load(Ordering::Acquire)
}

pub fn set_review_notifications_enabled(enabled: bool) {
    REVIEW_NOTIFICATIONS.store(enabled, Ordering::Release);
}

pub fn review_notifications_enabled() -> bool {
    REVIEW_NOTIFICATIONS.load(Ordering::Acquire)
}

/// The whole native review-notification decision, in one testable place.
/// Quiet mode forces the setting off for its duration and outranks it.
pub fn should_deliver_review_notification(quiet_mode: bool, setting_enabled: bool) -> bool {
    if quiet_mode && quiet_mode_suppresses(NoticeKind::ReviewReady) {
        return false;
    }
    setting_enabled
}

/// Guard for every overlay `show` / `arm` entry point: while quiet mode is on,
/// an overlay must not come back on its own schedule.
pub fn overlay_show_blocked() -> bool {
    is_quiet_mode_active() && quiet_mode_suppresses(NoticeKind::OverlayWindow)
}

/// Enter or leave quiet mode against a concrete window set. Returns the new
/// active state. Idempotent: entering twice keeps the first snapshot, so a
/// double-enter can never lose the restore list.
pub fn apply_quiet_mode<C: OverlayControl + ?Sized>(control: &mut C, active: bool) -> bool {
    let already = QUIET_MODE.load(Ordering::Acquire);
    if active == already {
        return already;
    }
    let mut saved = saved_overlays().lock().unwrap_or_else(|p| p.into_inner());
    if active {
        *saved = enter_quiet_mode(control);
        QUIET_MODE.store(true, Ordering::Release);
    } else {
        exit_quiet_mode(control, &saved);
        saved.clear();
        QUIET_MODE.store(false, Ordering::Release);
    }
    active
}

/// Labels currently held down by quiet mode — surfaced in the command payload
/// so a caller can confirm what was suppressed before starting a recording.
pub fn suppressed_overlay_labels() -> Vec<String> {
    saved_overlays()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .iter()
        .map(|state| state.label.clone())
        .collect()
}

// ── Tauri-backed implementation ──────────────────────────────────────────────

/// The real window set. Thin on purpose: every decision above is already made.
pub struct TauriOverlays<'a> {
    pub app: &'a tauri::AppHandle,
}

impl OverlayControl for TauriOverlays<'_> {
    fn snapshot(&self) -> Vec<OverlayState> {
        use tauri::Manager;
        let mut states = Vec::new();
        for label in OVERLAY_LABELS {
            let Some(window) = self.app.get_webview_window(label) else {
                continue;
            };
            states.push(OverlayState {
                label: label.to_string(),
                visible: window.is_visible().unwrap_or(false),
                position: window
                    .outer_position()
                    .ok()
                    .map(|position| (position.x, position.y)),
                // Every satellite is safe to hide: none of them owns an event
                // tap. The dock's cursor hit-test poller reads the GLOBAL cursor
                // and only flips `set_ignore_cursor_events`, which a hidden
                // window ignores; the Fn / Right-Option taps live in
                // `fn_hotkey.rs` on a CGEventTap, not in any overlay webview.
                strategy: OverlayHideStrategy::Hidden,
            });
        }
        states
    }

    fn hide(&mut self, label: &str) {
        use tauri::Manager;
        if let Some(window) = self.app.get_webview_window(label) {
            let _ = window.hide();
        }
    }

    fn show(&mut self, label: &str) {
        use tauri::Manager;
        if let Some(window) = self.app.get_webview_window(label) {
            let _ = window.show();
        }
    }

    fn set_position(&mut self, label: &str, x: i32, y: i32) {
        use tauri::Manager;
        if let Some(window) = self.app.get_webview_window(label) {
            let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[derive(Default)]
    struct FakeOverlays {
        windows: BTreeMap<String, (bool, Option<(i32, i32)>, OverlayHideStrategy)>,
        calls: Vec<String>,
    }

    impl FakeOverlays {
        fn with(entries: &[(&str, bool, Option<(i32, i32)>, OverlayHideStrategy)]) -> Self {
            let mut fake = FakeOverlays::default();
            for (label, visible, position, strategy) in entries {
                fake.windows
                    .insert((*label).to_string(), (*visible, *position, *strategy));
            }
            fake
        }
    }

    impl OverlayControl for FakeOverlays {
        fn snapshot(&self) -> Vec<OverlayState> {
            self.windows
                .iter()
                .map(|(label, (visible, position, strategy))| OverlayState {
                    label: label.clone(),
                    visible: *visible,
                    position: *position,
                    strategy: *strategy,
                })
                .collect()
        }

        fn hide(&mut self, label: &str) {
            self.calls.push(format!("hide:{label}"));
            if let Some(entry) = self.windows.get_mut(label) {
                entry.0 = false;
            }
        }

        fn show(&mut self, label: &str) {
            self.calls.push(format!("show:{label}"));
            if let Some(entry) = self.windows.get_mut(label) {
                entry.0 = true;
            }
        }

        fn set_position(&mut self, label: &str, x: i32, y: i32) {
            self.calls.push(format!("move:{label}:{x},{y}"));
            if let Some(entry) = self.windows.get_mut(label) {
                entry.1 = Some((x, y));
            }
        }
    }

    #[test]
    fn hide_restore_round_trip_returns_the_window_set_untouched() {
        let entries = [
            ("agent-partials", true, Some((10, 900)), OverlayHideStrategy::Hidden),
            ("dock", true, Some((640, 0)), OverlayHideStrategy::Hidden),
            ("point-overlay", true, Some((0, 0)), OverlayHideStrategy::Hidden),
            ("spatial-ink", true, Some((0, 0)), OverlayHideStrategy::Hidden),
        ];
        let mut fake = FakeOverlays::with(&entries);
        let before = fake.snapshot();

        let saved = enter_quiet_mode(&mut fake);
        assert_eq!(saved.len(), 4);
        assert!(
            fake.snapshot().iter().all(|state| !state.visible),
            "every overlay must be off screen while quiet mode is active"
        );

        exit_quiet_mode(&mut fake, &saved);
        assert_eq!(fake.snapshot(), before, "exit must restore state exactly");
    }

    #[test]
    fn an_overlay_that_was_already_down_stays_down_after_exit() {
        let mut fake = FakeOverlays::with(&[
            ("dock", true, Some((640, 0)), OverlayHideStrategy::Hidden),
            ("spatial-ink", false, Some((0, 0)), OverlayHideStrategy::Hidden),
        ]);

        let saved = enter_quiet_mode(&mut fake);
        assert_eq!(saved.len(), 1, "only the visible overlay is recorded");
        exit_quiet_mode(&mut fake, &saved);

        let after = fake.snapshot();
        assert!(after.iter().find(|s| s.label == "dock").unwrap().visible);
        assert!(
            !after.iter().find(|s| s.label == "spatial-ink").unwrap().visible,
            "quiet mode must not resurrect an overlay the operator had already closed"
        );
    }

    #[test]
    fn a_moved_overlay_records_where_it_was_and_is_put_back_there() {
        let mut fake = FakeOverlays::with(&[(
            "dock",
            true,
            Some((640, 0)),
            OverlayHideStrategy::MovedOffscreen,
        )]);

        let saved = enter_quiet_mode(&mut fake);
        assert_eq!(
            fake.snapshot()[0].position,
            Some(OFFSCREEN_ORIGIN),
            "a moved overlay parks off screen instead of hiding"
        );
        assert!(
            fake.snapshot()[0].visible,
            "a moved overlay stays mapped so its event tap survives"
        );

        exit_quiet_mode(&mut fake, &saved);
        assert_eq!(fake.snapshot()[0].position, Some((640, 0)));
    }

    #[test]
    fn a_missing_window_is_skipped_rather_than_faulting() {
        let mut fake = FakeOverlays::default();
        let saved = enter_quiet_mode(&mut fake);
        assert!(saved.is_empty());
        exit_quiet_mode(&mut fake, &saved);
        assert!(fake.calls.is_empty());
    }

    #[test]
    fn critical_notices_survive_quiet_mode_and_the_rest_do_not() {
        for kind in [
            NoticeKind::Approval,
            NoticeKind::Error,
            NoticeKind::UpdateAvailable,
        ] {
            assert!(
                !quiet_mode_suppresses(kind),
                "{} is critical and must still reach the operator",
                kind.as_str()
            );
        }
        for kind in [
            NoticeKind::ReviewReady,
            NoticeKind::CoachCard,
            NoticeKind::StatusPill,
            NoticeKind::Toast,
            NoticeKind::OverlayWindow,
        ] {
            assert!(
                quiet_mode_suppresses(kind),
                "{} is a convenience surface and must be suppressed",
                kind.as_str()
            );
        }
    }

    #[test]
    fn quiet_mode_outranks_the_review_notification_setting() {
        assert!(should_deliver_review_notification(false, true));
        assert!(!should_deliver_review_notification(false, false));
        assert!(!should_deliver_review_notification(true, true));
        assert!(!should_deliver_review_notification(true, false));
    }
}
