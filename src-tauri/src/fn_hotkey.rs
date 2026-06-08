//! Global Fn hotkey → system-wide push-to-talk dictation (macOS only).
//!
//! Lifted from aqua/Symon's `start_fn_key_monitor` and trimmed to push-to-talk
//! only — the Fn+R screen-reading, double-tap long-form, and Right-Option Ask
//! paths are intentionally dropped. What remains:
//!
//! - A raw `CGEventTap` at `CGEventTapLocation::HID` (Sequoia 15.7.x has a
//!   confirmed regression where SESSION-level taps silently stop delivering
//!   events; HID taps run earlier in the pipeline and are unaffected).
//! - Hold Fn → `paste::save_frontmost_app()` + `stt_engine::start()`.
//!   Release Fn → `stt_engine::stop()`; the finalize chain pastes (see the
//!   origin branch in `lib.rs::stt_engine::run_finalize`).
//! - A 40ms `CGEventSourceFlagsState` poll fallback for the dropped Fn-UP edge
//!   (the other half of the same Sequoia regression — the tap delivers the
//!   Fn-down FlagsChanged then goes silent, so the natural release never fires).
//! - `catch_unwind` around the entire callback body. The closure runs inside an
//!   extern "C" CGEvent tap callback; a panic cannot unwind across the C
//!   boundary — it ABORTS the whole o8 process (killing the Node sidecars). The
//!   catch converts any panic into a logged no-op so the app stays alive.
//!
//! The tap callback returns in microseconds: it only flips an `AtomicBool` edge
//! latch and spawns a worker thread. All STT / paste / activate work runs off
//! the tap thread — macOS auto-disables a tap whose callback runs too slowly.
//!
//! CRITICAL: this REUSES o8's existing `stt_engine` daemon. It NEVER spawns a
//! second recognizer — the Swift `speech_recognizer` sidecar is already owned by
//! `stt_engine::spawn` (called once from `setup()`).

#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
#[cfg(target_os = "macos")]
use std::sync::{Arc, Mutex, OnceLock};
#[cfg(target_os = "macos")]
use tauri::Emitter;

/// The app handle, stored once at `start()`, so the off-tap worker threads can
/// re-assert the always-on screen dock pill window + emit the `system-start`
/// event on Fn-down (system-wide Symon fold P3). Cloned per use; AppHandle is
/// cheap to clone.
#[cfg(target_os = "macos")]
static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

/// True while a dictation was started by the global Fn hotkey (system path)
/// rather than the in-window mic button. `run_finalize` reads this to decide
/// whether to PASTE the polished text into the focused app (system origin) or
/// EMIT it to the composer (in-window origin). Set at Fn-down, cleared inside
/// `run_finalize` after the paste fires.
#[cfg(target_os = "macos")]
static SYSTEM_DICTATION_ORIGIN: AtomicBool = AtomicBool::new(false);

/// Mark the current dictation as system-originated (called at Fn-down).
#[cfg(target_os = "macos")]
pub fn set_system_origin(on: bool) {
    SYSTEM_DICTATION_ORIGIN.store(on, Ordering::SeqCst);
}

/// Whether the active dictation was started by the global Fn hotkey.
#[cfg(target_os = "macos")]
pub fn is_system_origin() -> bool {
    SYSTEM_DICTATION_ORIGIN.load(Ordering::SeqCst)
}

#[cfg(not(target_os = "macos"))]
pub fn set_system_origin(_on: bool) {}

#[cfg(not(target_os = "macos"))]
pub fn is_system_origin() -> bool {
    false
}

/// Last polished system-dictation transcript, stashed at the end of
/// `run_finalize` so the ⌘⌥V global shortcut can re-paste it (voice P3). Holds
/// only the most recent entry — the trimmed equivalent of Symon's transcript
/// store, scoped to the single value ⌘⌥V needs.
#[cfg(target_os = "macos")]
static LAST_VOICE_TRANSCRIPT: Mutex<Option<String>> = Mutex::new(None);

/// Record the latest polished system transcript (called from `run_finalize`).
#[cfg(target_os = "macos")]
pub fn set_last_voice_transcript(text: &str) {
    if let Ok(mut g) = LAST_VOICE_TRANSCRIPT.lock() {
        *g = Some(text.to_string());
    }
}

/// The most recent polished system transcript, if any (⌘⌥V paste-last).
#[cfg(target_os = "macos")]
pub fn last_voice_transcript() -> Option<String> {
    LAST_VOICE_TRANSCRIPT.lock().ok().and_then(|g| g.clone())
}

#[cfg(not(target_os = "macos"))]
pub fn set_last_voice_transcript(_text: &str) {}

#[cfg(not(target_os = "macos"))]
pub fn last_voice_transcript() -> Option<String> {
    None
}

/// NSEventModifierFlagFunction = 1 << 23.
#[cfg(target_os = "macos")]
const FN_FLAG: u64 = 0x800000;

/// Minimum Fn hold before we treat the press as a real dictation. A brush under
/// this just flips the recognizer on and off with no paste — same failure mode
/// as aqua's FN_TAP_PRIMER_MAX_MS.
#[cfg(target_os = "macos")]
const FN_TAP_PRIMER_MAX_MS: u64 = 220;

/// Max gap between two Fn brushes for them to count as a DOUBLE-TAP (which
/// toggles long-form dictation). Verbatim from Symon's `LONG_FORM_FN_DOUBLE_TAP_MS`.
#[cfg(target_os = "macos")]
const LONG_FORM_FN_DOUBLE_TAP_MS: u64 = 480;

/// macOS Escape key virtual keycode — cancels an active long-form dictation.
#[cfg(target_os = "macos")]
const ESCAPE_KEYCODE: i64 = 53;

/// NSEventModifierFlagOption = 1 << 19. Set for BOTH Option keys.
#[cfg(target_os = "macos")]
const OPTION_FLAG: u64 = 0x80000;

/// Virtual keycode for the RIGHT Option key (Left Option = 58). The flag bit is
/// shared, so the keycode is the only way to tell them apart — Ask is bound to
/// Right-Option so Left-Option stays free for normal Option chords.
#[cfg(target_os = "macos")]
const RIGHT_OPTION_KEYCODE: i64 = 61;

/// Right-Option hold under this is a brush (cancel, don't ask). Verbatim from
/// Symon's 120ms Ask brush guard.
#[cfg(target_os = "macos")]
const ASK_BRUSH_MS: u64 = 120;

/// True while a Right-Option ASK dictation is recording a question. `run_finalize`
/// takes this to route the polished transcript to Gemini (speak the answer)
/// instead of pasting it. Distinct from SYSTEM_DICTATION_ORIGIN (paste) and
/// LONG_FORM_ACTIVE.
#[cfg(target_os = "macos")]
static ASK_MODE: AtomicBool = AtomicBool::new(false);

/// Edge latch for the Right-Option key (dedupes duplicate FlagsChanged events).
#[cfg(target_os = "macos")]
static OPTION_HELD: AtomicBool = AtomicBool::new(false);

/// The stt_engine session id of the active Ask dictation (0 = none). Fenced like
/// the long-form session id so a late teardown can't kill a newer session.
#[cfg(target_os = "macos")]
static ASK_SESSION_ID: AtomicU64 = AtomicU64::new(0);

/// Whether a Right-Option Ask dictation is currently recording. Read by
/// `run_finalize` (via take_ask_mode) to route the result to Gemini.
#[cfg(target_os = "macos")]
pub fn take_ask_mode() -> bool {
    ASK_MODE.swap(false, Ordering::SeqCst)
}

#[cfg(not(target_os = "macos"))]
pub fn take_ask_mode() -> bool {
    false
}

/// True while a DOUBLE-TAP-Fn long-form dictation is active. Unlike push-to-talk
/// (which ends on Fn release), long-form stays on until a single Fn tap finishes
/// it (or Escape cancels). Read by the tap callback + the poll fallback; written
/// synchronously in the tap callback (toggle edges) + the begin/finish helpers.
#[cfg(target_os = "macos")]
static LONG_FORM_ACTIVE: AtomicBool = AtomicBool::new(false);

/// The stt_engine session id of the active long-form dictation (0 = none). Set
/// when `begin_long_form_dictation` starts the recognizer; zeroed on finish /
/// cancel. The finish edge requires this to be non-zero so a double-tap that
/// raced a still-starting session can't finish a session that never began.
#[cfg(target_os = "macos")]
static LONG_FORM_SESSION_ID: AtomicU64 = AtomicU64::new(0);

/// Timestamp of the last sub-threshold Fn brush release. The next Fn-down within
/// `LONG_FORM_FN_DOUBLE_TAP_MS` is a double-tap. Consumed on read.
#[cfg(target_os = "macos")]
static LAST_FN_BRUSH: Mutex<Option<std::time::Instant>> = Mutex::new(None);

/// The dictation session id whose finalize must be DROPPED (long-form
/// Escape-cancel). 0 = none. Per-session (not a bare bool) so a concurrent,
/// non-cancelled finalize can't consume a discard meant for the cancelled one.
#[cfg(target_os = "macos")]
static DISCARD_FINALIZE_SESSION: AtomicU64 = AtomicU64::new(0);

/// The session id of the most recent push-to-talk / brush dictation. Lets the
/// brush + release teardown fence on its OWN session (`stop_session`) so a late
/// brush teardown can't kill a long-form session the user started right after.
#[cfg(target_os = "macos")]
static CURRENT_PTT_SESSION_ID: AtomicU64 = AtomicU64::new(0);

/// Request that session `sid`'s finalize be discarded (long-form Escape-cancel).
#[cfg(target_os = "macos")]
pub fn request_discard_finalize(sid: u64) {
    DISCARD_FINALIZE_SESSION.store(sid, Ordering::SeqCst);
}

/// Whether session `sid`'s finalize should be dropped. Clears the request on a
/// match (so ONLY that session is discarded). `run_finalize` calls this at its
/// top with its own session id.
#[cfg(target_os = "macos")]
pub fn take_discard_finalize(sid: u64) -> bool {
    sid != 0
        && DISCARD_FINALIZE_SESSION
            .compare_exchange(sid, 0, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
}

#[cfg(not(target_os = "macos"))]
pub fn request_discard_finalize(_sid: u64) {}

#[cfg(not(target_os = "macos"))]
pub fn take_discard_finalize(_sid: u64) -> bool {
    false
}

/// Whether the just-arrived Fn-down completes a double-tap. Consumes the stored
/// brush timestamp on BOTH branches so a single stale brush can't match twice.
#[cfg(target_os = "macos")]
fn consume_double_tap_brush() -> bool {
    let mut guard = match LAST_FN_BRUSH.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    let matched = matches!(
        *guard,
        Some(t) if t.elapsed() <= std::time::Duration::from_millis(LONG_FORM_FN_DOUBLE_TAP_MS)
    );
    *guard = None;
    matched
}

/// CFMachPortRef of the Fn-key event tap, stored as raw pointer bits so the
/// callback can re-enable the tap when macOS auto-disables it
/// (`kCGEventTapDisabledByTimeout` / `kCGEventTapDisabledByUserInput`).
#[cfg(target_os = "macos")]
static FN_TAP_MACH_PORT: OnceLock<usize> = OnceLock::new();

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventTapEnable(tap: *mut std::ffi::c_void, enable: bool);
    fn CGEventSourceFlagsState(state_id: i32) -> u64;
}

/// Begin a system-origin dictation: remember the focused app, mark the origin,
/// then start the SHARED stt_engine daemon. Runs on a worker thread, never the
/// tap callback.
#[cfg(target_os = "macos")]
fn begin_system_dictation() {
    // Duck system audio so the mic hears over playing audio — including o8's
    // own TTS, so the user can talk back while it's still speaking (#1207).
    crate::audio_ducker::duck();
    // Save the paste target BEFORE any focus could shift. Crucially this also
    // happens BEFORE the dock pill is ordered front — the dock window is
    // nonactivating so it shouldn't steal focus, but capturing the frontmost
    // app first is the belt-and-suspenders guarantee for the paste target.
    crate::paste::save_frontmost_app();
    set_system_origin(true);

    // Morph the ALWAYS-ON screen dock pill into 'recording' (P3). The dock
    // window is created visible at boot and stays up — we do NOT show it from
    // hidden. `dock_window::show` here just RE-ASSERTS it (re-anchor to the
    // active monitor + re-order front nonactivating). The dock filters
    // `o8:stt-event` to origin==system; `system-start` morphs the idle capsule
    // into 'recording' immediately so the user sees the waveform the instant they
    // hold Fn, before the daemon's first partial lands. Both run on the main
    // thread (window + emit).
    if let Some(app) = APP_HANDLE.get() {
        let app = app.clone();
        let _ = app.run_on_main_thread({
            let app = app.clone();
            move || {
                crate::dock_window::show(&app);
                let payload =
                    serde_json::json!({ "type": "system-start", "origin": "system" });
                // Emit DIRECTLY to the dock window so the morph (idle → recording)
                // always lands — the broadcast `app.emit` can miss the second
                // (dock) webview. `emit_to(DOCK_LABEL, …)` is the reliable path.
                log::info!("[fn-hotkey] morph dock → recording (system-start → dock)");
                let _ = app.emit_to(
                    crate::dock_window::DOCK_LABEL,
                    "o8:stt-event",
                    payload.clone(),
                );
                // Keep the broadcast too for any other listeners (no-op for the
                // in-window pill, which ignores system-origin events).
                let _ = app.emit("o8:stt-event", payload);
            }
        });
    }

    match crate::stt_engine::start() {
        Ok(sid) => {
            CURRENT_PTT_SESSION_ID.store(sid, Ordering::SeqCst);
            tracing::info!("[fn-hotkey] system dictation started (session={sid})");
        }
        Err(e) => {
            tracing::error!("[fn-hotkey] failed to start dictation: {e}");
            set_system_origin(false);
            // CURRENT_PTT_SESSION_ID is intentionally left at its previous value
            // here — a failed start has no live session to stop, and a later
            // release that loads the stale id will simply no-op in stop_session
            // (active_session() has already moved past it). Safe by the fence.
            // The session never started — morph the always-on dock back to its
            // idle capsule (do NOT hide; the dock is always-on).
            morph_dock_idle();
        }
    }
}

/// Morph the ALWAYS-ON screen dock pill back to its idle capsule from any worker
/// thread (hops to the main thread). Emits a `system-idle` event the
/// `/dictation-pill` route reduces back to idle — the dock window stays on
/// screen (it is never hidden on the normal flow). No-op if the app handle isn't
/// stored yet.
#[cfg(target_os = "macos")]
fn morph_dock_idle() {
    // Dictation ended (discard / cancel / error) — restore any ducked system
    // volume. Idempotent: a no-op when nothing was ducked (#1207).
    crate::audio_ducker::restore();
    if let Some(app) = APP_HANDLE.get() {
        let app = app.clone();
        let _ = app.run_on_main_thread({
            let app = app.clone();
            move || {
                let payload =
                    serde_json::json!({ "type": "system-idle", "origin": "system" });
                // Direct-to-dock so the morph back to the idle capsule always lands.
                log::info!("[fn-hotkey] morph dock → idle (system-idle → dock)");
                let _ = app.emit_to(
                    crate::dock_window::DOCK_LABEL,
                    "o8:stt-event",
                    payload.clone(),
                );
                let _ = app.emit("o8:stt-event", payload);
            }
        });
    }
}

/// End a system-origin dictation. The finalize chain (Whisper → polish → paste)
/// fires off the daemon's final/audio_file stdout events; the origin branch in
/// `run_finalize` routes the polished text to `paste::paste_text`.
#[cfg(target_os = "macos")]
fn end_system_dictation() {
    // Restore ducked volume the instant the user stops talking (#1207).
    crate::audio_ducker::restore();
    // Fence on the push-to-talk session so a release that raced a newer session
    // (e.g. a double-tap that already promoted to long-form) can't stop the
    // wrong one. For a normal hold this is just the active session.
    let sid = CURRENT_PTT_SESSION_ID.load(Ordering::SeqCst);
    if let Err(e) = crate::stt_engine::stop_session(sid) {
        tracing::warn!("[fn-hotkey] stop failed: {e}");
    }
}

/// Discard a too-short Fn brush: stop the recognizer and clear the origin so a
/// stray finalize doesn't paste an empty string into the focused app. Morph the
/// always-on dock back to its idle capsule (we emitted `system-start` on Fn-down,
/// so without this the brush would leave the dock stuck in 'recording'). The
/// dock is NEVER hidden — it morphs back to idle.
#[cfg(target_os = "macos")]
fn discard_brush() {
    set_system_origin(false);
    // Fence on the brush's OWN session — if a double-tap already promoted to a
    // long-form session, this late brush teardown must NOT stop it (stop_session
    // no-ops when a newer session is active).
    let sid = CURRENT_PTT_SESSION_ID.load(Ordering::SeqCst);
    let _ = crate::stt_engine::stop_session(sid);
    morph_dock_idle();
}

/// Begin a DOUBLE-TAP-Fn long-form dictation. Like `begin_system_dictation` but
/// records the session id so a later single tap can finish it, and the recognizer
/// is NOT torn down on Fn release (the tap callback's up-edge + the poll skip it
/// while `LONG_FORM_ACTIVE`). Runs on a worker thread, never the tap callback.
/// `LONG_FORM_ACTIVE` is already set true synchronously by the tap callback.
#[cfg(target_os = "macos")]
fn begin_long_form_dictation() {
    crate::audio_ducker::duck();
    crate::paste::save_frontmost_app();
    set_system_origin(true);

    // Morph the always-on dock into 'recording' (same surface as push-to-talk —
    // the user sees the waveform). Emit DIRECTLY to the dock window.
    if let Some(app) = APP_HANDLE.get() {
        let app = app.clone();
        let _ = app.run_on_main_thread({
            let app = app.clone();
            move || {
                crate::dock_window::show(&app);
                let payload =
                    serde_json::json!({ "type": "system-start", "origin": "system" });
                log::info!("[fn-hotkey] morph dock → recording (long-form start)");
                let _ = app.emit_to(
                    crate::dock_window::DOCK_LABEL,
                    "o8:stt-event",
                    payload.clone(),
                );
                let _ = app.emit("o8:stt-event", payload);
            }
        });
    }

    match crate::stt_engine::start() {
        Ok(sid) => {
            LONG_FORM_SESSION_ID.store(sid, Ordering::SeqCst);
            tracing::info!("[fn-hotkey] long-form dictation started (session={sid})");
        }
        Err(e) => {
            tracing::error!("[fn-hotkey] failed to start long-form dictation: {e}");
            // Roll the toggle back so a single tap doesn't try to finish a
            // session that never started.
            LONG_FORM_ACTIVE.store(false, Ordering::SeqCst);
            LONG_FORM_SESSION_ID.store(0, Ordering::SeqCst);
            set_system_origin(false);
            morph_dock_idle();
        }
    }
}

/// Finish an active long-form dictation (a single Fn tap toggled it off). Zero
/// the session id, then stop the recognizer — the finalize chain pastes the
/// polished text exactly like push-to-talk (origin is still system; the dock
/// flashes the words via `run_finalize`). `LONG_FORM_ACTIVE` was already cleared
/// synchronously by the tap callback.
#[cfg(target_os = "macos")]
fn finish_long_form_dictation() {
    crate::audio_ducker::restore();
    // Fence on the long-form session so a finish that raced a brand-new
    // push-to-talk the user started right after can't stop the new session.
    let sid = LONG_FORM_SESSION_ID.swap(0, Ordering::SeqCst);
    if let Err(e) = crate::stt_engine::stop_session(sid) {
        tracing::warn!("[fn-hotkey] long-form finish stop failed: {e}");
    }
}

/// Cancel an active long-form dictation (Escape) WITHOUT pasting. Clear the
/// origin AND request that the impending finalize be dropped entirely (no paste,
/// no composer emit) BEFORE stopping the recognizer, so the finalize that `stop`
/// triggers sees both flags. Morph the dock back to its idle capsule.
#[cfg(target_os = "macos")]
fn cancel_long_form_dictation() {
    let sid = LONG_FORM_SESSION_ID.swap(0, Ordering::SeqCst);
    set_system_origin(false);
    // Mark THIS session's finalize for discard, then stop it (fenced). Order
    // matters — the discard request must be set BEFORE stop() triggers the
    // daemon finalize that run_finalize handles.
    request_discard_finalize(sid);
    if let Err(e) = crate::stt_engine::stop_session(sid) {
        tracing::warn!("[fn-hotkey] long-form cancel stop failed: {e}");
    }
    log::info!("[fn-hotkey] long-form cancelled (Escape) — no paste");
    morph_dock_idle();
}

/// Begin a Right-Option ASK dictation: mark ASK_MODE, morph the dock to
/// 'recording' (so the user sees Ask is listening for the question), and start
/// the SHARED recognizer. `run_finalize` routes the polished transcript to
/// Gemini (speaks the answer) instead of pasting. Worker thread, never the tap.
#[cfg(target_os = "macos")]
fn begin_ask_dictation() {
    crate::audio_ducker::duck();
    // Ask takes the mic: the three voice modes (push-to-talk, long-form, ask)
    // share ONE recognizer + active_session, so abandon any in-flight session
    // first. Clear the competing flags and discard the prior session's finalize
    // (so it never pastes); the start() below supersedes active_session. Without
    // this, pressing Right-Option mid-Fn/long-form left the other mode's flags
    // set + an un-finishable session over the shared recognizer.
    LONG_FORM_ACTIVE.store(false, Ordering::SeqCst);
    LONG_FORM_SESSION_ID.store(0, Ordering::SeqCst);
    set_system_origin(false);
    let prev = crate::stt_engine::active_session_id();
    if prev != 0 {
        request_discard_finalize(prev);
    }

    ASK_MODE.store(true, Ordering::SeqCst);

    if let Some(app) = APP_HANDLE.get() {
        let app = app.clone();
        let _ = app.run_on_main_thread({
            let app = app.clone();
            move || {
                crate::dock_window::show(&app);
                let payload = serde_json::json!({ "type": "system-start", "origin": "system" });
                log::info!("[fn-hotkey] morph dock → recording (ask start)");
                let _ = app.emit_to(
                    crate::dock_window::DOCK_LABEL,
                    "o8:stt-event",
                    payload.clone(),
                );
                let _ = app.emit("o8:stt-event", payload);
                // Tell the dock's Ask answer panel to open (grow + show listening).
                // The panel itself calls dock_set_expanded to resize; this event is
                // the trigger. Dock-only — the in-window surface ignores it.
                let _ = app.emit_to(
                    crate::dock_window::DOCK_LABEL,
                    "o8:ask-open",
                    serde_json::json!({}),
                );
            }
        });
    }

    match crate::stt_engine::start() {
        Ok(sid) => {
            // A sub-120ms brush (discard_ask_dictation) may have cleared ASK_MODE
            // while we were starting — tear down the session we just started
            // rather than leave a dangling recorder nobody stops.
            if !ASK_MODE.load(Ordering::SeqCst) {
                let _ = crate::stt_engine::stop_session(sid);
                morph_dock_idle();
                return;
            }
            ASK_SESSION_ID.store(sid, Ordering::SeqCst);
            tracing::info!("[fn-hotkey] ask dictation started (session={sid})");
        }
        Err(e) => {
            tracing::error!("[fn-hotkey] failed to start ask dictation: {e}");
            ASK_MODE.store(false, Ordering::SeqCst);
            ASK_SESSION_ID.store(0, Ordering::SeqCst);
            morph_dock_idle();
        }
    }
}

/// Finish an Ask dictation (Right-Option released ≥120ms): stop the recognizer
/// (fenced) → the finalize chain polishes the question, and run_finalize routes
/// it to Gemini via take_ask_mode. ASK_MODE stays set until run_finalize takes it.
#[cfg(target_os = "macos")]
fn end_ask_dictation() {
    crate::audio_ducker::restore();
    let sid = ASK_SESSION_ID.swap(0, Ordering::SeqCst);
    if let Err(e) = crate::stt_engine::stop_session(sid) {
        tracing::warn!("[fn-hotkey] ask finish stop failed: {e}");
    }
}

/// Discard a too-short Right-Option brush: clear ASK_MODE, drop the finalize, and
/// stop the recognizer (fenced). Morph the dock back to its idle capsule.
#[cfg(target_os = "macos")]
fn discard_ask_dictation() {
    let sid = ASK_SESSION_ID.swap(0, Ordering::SeqCst);
    ASK_MODE.store(false, Ordering::SeqCst);
    request_discard_finalize(sid);
    if let Err(e) = crate::stt_engine::stop_session(sid) {
        tracing::warn!("[fn-hotkey] ask cancel stop failed: {e}");
    }
    morph_dock_idle();
}

/// Spawn the global Fn hotkey monitor. Call ONCE from `setup()` alongside
/// `stt_engine::spawn`. On non-macOS this is a no-op.
#[cfg(target_os = "macos")]
pub fn start(app: tauri::AppHandle) {
    use core_graphics::event::{
        CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement, CGEventType,
        EventField,
    };

    // Stash the app handle so the off-tap worker threads can drive the screen
    // dock pill window (show on Fn-down, hide on brush/error). Ignore a second
    // call — `start()` is invoked once from setup().
    let _ = APP_HANDLE.set(app.clone());

    // Trigger the native macOS Accessibility prompt if we don't already have
    // permission. CGEventTapCreate silently succeeds even without Accessibility
    // and Fn would never fire otherwise.
    if crate::mac_perms::accessibility_permission_granted(true) {
        tracing::info!("[fn-hotkey] Accessibility: granted");
    } else {
        tracing::error!(
            "[fn-hotkey] Accessibility NOT granted — the Fn hotkey will not work until you \
             enable o8 in System Settings → Privacy & Security → Accessibility, then relaunch."
        );
    }

    // macOS Sequoia binds Fn to "Start Dictation" by default; Apple's dictation
    // intercepts the press before our tap can react. Surface it so onboarding
    // can nudge the user to set Fn → Do Nothing.
    match crate::mac_perms::fn_key_usage_type() {
        Some(0) => tracing::info!("[fn-hotkey] Fn key binding: Do Nothing ✓"),
        other => {
            let value = other.unwrap_or(3);
            let label = match value {
                1 => "Change Input Source",
                2 => "Show Emoji & Symbols",
                3 => "Start Dictation",
                _ => "unknown",
            };
            tracing::warn!(
                "[fn-hotkey] Fn key bound to '{label}' (AppleFnUsageType={value}); o8's Fn capture \
                 will be unreliable until you set System Settings → Keyboard → \
                 Press 🌐 key to → Do Nothing."
            );
        }
    }

    // Edge latch shared by the tap callback and the poll fallback. `true` means
    // a dictation is currently active (Fn held).
    let fn_held = Arc::new(AtomicBool::new(false));
    // Fn-down instant, used to reject sub-threshold brushes on release.
    let fn_press_time = Arc::new(Mutex::new(std::time::Instant::now()));
    // Right-Option-down instant, used to reject the sub-120ms Ask brush.
    let ask_press_time = Arc::new(Mutex::new(std::time::Instant::now()));

    // ── Poll fallback for the dropped Fn-UP edge (Sequoia regression) ──
    // The tap delivers ONE FlagsChanged (Fn-down) then goes silent; the Fn-up
    // transition never reaches the callback. Poll the hardware modifier state
    // every 40ms and run the same teardown when the FN bit drops while a
    // dictation is active. 40ms is imperceptible (a human Fn release is ≥80ms).
    {
        let fn_held_poll = fn_held.clone();
        // kCGEventSourceStateCombinedSessionState = 1.
        const CG_STATE_COMBINED_SESSION: i32 = 1;
        std::thread::spawn(move || {
            let mut was_held = false;
            loop {
                std::thread::sleep(std::time::Duration::from_millis(40));
                let actual_held =
                    unsafe { (CGEventSourceFlagsState(CG_STATE_COMBINED_SESSION) & FN_FLAG) != 0 };

                if was_held && !actual_held {
                    // Long-form ignores Fn release — it ends only on a single tap,
                    // never from the poll. Skip the teardown entirely (otherwise
                    // the Fn-up after the double-tap would end the session).
                    if LONG_FORM_ACTIVE.load(Ordering::SeqCst) {
                        was_held = actual_held;
                        continue;
                    }
                    // Atomic claim against the tap's own Fn-up handler — whichever
                    // path swaps the latch first owns the release; the other skips.
                    if fn_held_poll.swap(false, Ordering::SeqCst) {
                        tracing::info!(
                            "[fn-hotkey] Fn release caught by poll fallback (tap missed up-edge)"
                        );
                        std::thread::spawn(end_system_dictation);
                    }
                }
                was_held = actual_held;
            }
        });
    }

    // ── The CGEventTap thread ──
    let fn_held_cb = fn_held.clone();
    let fn_press_time_cb = fn_press_time.clone();
    let ask_press_time_cb = ask_press_time.clone();
    std::thread::spawn(move || {
        let tap = CGEventTap::new(
            CGEventTapLocation::HID,
            CGEventTapPlacement::HeadInsertEventTap,
            CGEventTapOptions::ListenOnly,
            vec![CGEventType::FlagsChanged, CGEventType::KeyDown],
            move |_proxy, event_type, event| {
                // macOS auto-disables a tap whose callback runs too slowly
                // (kCGEventTapDisabledByTimeout) or in response to certain input
                // (kCGEventTapDisabledByUserInput). Re-enable immediately via the
                // stored mach_port; without this the tap dies after one slow call.
                if matches!(
                    event_type,
                    CGEventType::TapDisabledByTimeout | CGEventType::TapDisabledByUserInput
                ) {
                    tracing::warn!(
                        "[fn-hotkey] CGEventTap disabled by macOS ({event_type:?}); re-enabling"
                    );
                    if let Some(&port_bits) = FN_TAP_MACH_PORT.get() {
                        unsafe {
                            CGEventTapEnable(port_bits as *mut std::ffi::c_void, true);
                        }
                    }
                    return None;
                }

                // The entire body is wrapped in catch_unwind: a panic here would
                // unwind across the extern "C" tap boundary and ABORT all of o8
                // (killing the Node sidecars). Convert any panic into a logged
                // no-op so the app survives.
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    // KeyDown: the ONLY key we react to is Escape, and only to
                    // CANCEL an active long-form dictation. This is a ListenOnly
                    // tap — we never consume the key (always return None); the
                    // keycode is read purely to detect Escape. The read is gated on
                    // LONG_FORM_ACTIVE so the common case (no long-form) stays the
                    // same cheap early return as before.
                    if matches!(event_type, CGEventType::KeyDown) {
                        // Escape cancels an active long-form dictation AND stops
                        // active TTS playback. Both atomic loads are cheap, so
                        // the common case (neither active) stays the same early
                        // return; the keycode is only read when one is live.
                        let long_form = LONG_FORM_ACTIVE.load(Ordering::SeqCst);
                        let tts_active = crate::tts::playback::is_active();
                        if long_form || tts_active {
                            let keycode =
                                event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE);
                            if keycode == ESCAPE_KEYCODE {
                                if long_form {
                                    // Clear the toggle synchronously; discard off-tap.
                                    LONG_FORM_ACTIVE.store(false, Ordering::SeqCst);
                                    std::thread::spawn(cancel_long_form_dictation);
                                }
                                if tts_active {
                                    std::thread::spawn(crate::tts::playback::stop);
                                }
                            }
                        }
                        return None;
                    }

                    let flags = event.get_flags().bits();
                    let fn_is_down = (flags & FN_FLAG) != 0;

                    // Edge-latch with compare-exchange so duplicate FlagsChanged
                    // events (macOS delivers them 2-3x on some keyboards) don't
                    // double-fire start/stop.
                    let down_edge = fn_is_down
                        && fn_held_cb
                            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                            .is_ok();
                    let up_edge = !fn_is_down
                        && fn_held_cb
                            .compare_exchange(true, false, Ordering::SeqCst, Ordering::SeqCst)
                            .is_ok();

                    if down_edge {
                        // Offload ALL work — the tap callback must return in
                        // microseconds or macOS drops subsequent input events.
                        if let Ok(mut t) = fn_press_time_cb.lock() {
                            *t = std::time::Instant::now();
                        }
                        // Ordered branches (the ORDER is load-bearing):
                        //   (a) a single tap while long-form is active FINISHES it,
                        //   (b) two quick taps START long-form (double-tap),
                        //   (c) otherwise a normal push-to-talk hold.
                        if LONG_FORM_ACTIVE.load(Ordering::SeqCst)
                            && LONG_FORM_SESSION_ID.load(Ordering::SeqCst) != 0
                        {
                            // Clear toggle + edge latch synchronously so this tap's
                            // impending Fn-up CAS fails (no brush/end) and the poll
                            // skips. The recognizer stop + paste run off-tap.
                            LONG_FORM_ACTIVE.store(false, Ordering::SeqCst);
                            fn_held_cb.store(false, Ordering::SeqCst);
                            std::thread::spawn(finish_long_form_dictation);
                        } else if consume_double_tap_brush() {
                            // Promote to long-form. Set the toggle + clear the edge
                            // latch synchronously so THIS tap's Fn-up no-ops.
                            LONG_FORM_ACTIVE.store(true, Ordering::SeqCst);
                            fn_held_cb.store(false, Ordering::SeqCst);
                            std::thread::spawn(begin_long_form_dictation);
                        } else {
                            std::thread::spawn(begin_system_dictation);
                        }
                    } else if up_edge {
                        // Fn release during long-form is a NO-OP — long-form ends
                        // only on a single tap (down-edge above), never on release.
                        // (begin_long_form already cleared fn_held, so this CAS
                        // usually won't even fire mid-long-form; guard anyway.)
                        if !LONG_FORM_ACTIVE.load(Ordering::SeqCst) {
                            let press_time = fn_press_time_cb
                                .lock()
                                .map(|t| *t)
                                .unwrap_or_else(|_| std::time::Instant::now());
                            let hold = std::time::Instant::now().duration_since(press_time);
                            if hold < std::time::Duration::from_millis(FN_TAP_PRIMER_MAX_MS) {
                                // Sub-threshold brush — tear down silently, no paste,
                                // and STAMP the brush so a quick second tap is read
                                // as a double-tap (long-form start).
                                if let Ok(mut g) = LAST_FN_BRUSH.lock() {
                                    *g = Some(std::time::Instant::now());
                                }
                                std::thread::spawn(discard_brush);
                            } else {
                                std::thread::spawn(end_system_dictation);
                            }
                        }
                    }

                    // ── Right-Option → Ask (voice question) ──
                    // keycode 61 = Right-Option (58 = Left); both set OPTION_FLAG,
                    // so the keycode is the only disambiguator. Hold to record a
                    // question, release (≥120ms) to send it to Gemini and speak the
                    // answer. Tap-only — aqua does the same (no poll fallback;
                    // unlike Fn, Option up-edges are delivered reliably). All work
                    // is offloaded; the tap callback only flips an atomic + spawns.
                    {
                        let keycode =
                            event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE);
                        if keycode == RIGHT_OPTION_KEYCODE {
                            let option_down = (flags & OPTION_FLAG) != 0;
                            let opt_down_edge = option_down
                                && OPTION_HELD
                                    .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                                    .is_ok();
                            let opt_up_edge = !option_down
                                && OPTION_HELD
                                    .compare_exchange(true, false, Ordering::SeqCst, Ordering::SeqCst)
                                    .is_ok();
                            if opt_down_edge {
                                if let Ok(mut t) = ask_press_time_cb.lock() {
                                    *t = std::time::Instant::now();
                                }
                                std::thread::spawn(begin_ask_dictation);
                            } else if opt_up_edge {
                                let press = ask_press_time_cb
                                    .lock()
                                    .map(|t| *t)
                                    .unwrap_or_else(|_| std::time::Instant::now());
                                let hold = std::time::Instant::now().duration_since(press);
                                if hold < std::time::Duration::from_millis(ASK_BRUSH_MS) {
                                    std::thread::spawn(discard_ask_dictation);
                                } else {
                                    std::thread::spawn(end_ask_dictation);
                                }
                            }
                        }
                    }

                    None // never modify the event
                }));

                match result {
                    Ok(val) => val,
                    Err(e) => {
                        let msg = e
                            .downcast_ref::<String>()
                            .map(|s| s.as_str())
                            .or_else(|| e.downcast_ref::<&str>().copied())
                            .unwrap_or("unknown panic");
                        tracing::error!("[fn-hotkey] CGEvent tap PANIC: {msg}");
                        None
                    }
                }
            },
        );

        match tap {
            Ok(tap) => {
                use core_foundation::base::TCFType;
                // Stash the mach_port pointer bits so the callback can re-enable
                // the tap. Raw bits because *mut isn't Send.
                let _ = FN_TAP_MACH_PORT.set(tap.mach_port.as_concrete_TypeRef() as usize);
                tracing::info!("[fn-hotkey] CGEventTap (HID) created — entering runloop");
                unsafe {
                    let loop_source = tap
                        .mach_port
                        .create_runloop_source(0)
                        .expect("[fn-hotkey] failed to create run loop source");
                    core_foundation::runloop::CFRunLoop::get_current().add_source(
                        &loop_source,
                        core_foundation::runloop::kCFRunLoopCommonModes,
                    );
                    tap.enable();
                    core_foundation::runloop::CFRunLoop::run_current();
                }
            }
            Err(e) => {
                tracing::error!("[fn-hotkey] failed to create CGEvent tap for Fn key: {e:?}");
                tracing::error!(
                    "[fn-hotkey] grant Accessibility + Input Monitoring: System Settings → \
                     Privacy & Security"
                );
            }
        }
    });
}

#[cfg(not(target_os = "macos"))]
pub fn start(_app: tauri::AppHandle) {}
