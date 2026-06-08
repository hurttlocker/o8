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
use std::sync::atomic::{AtomicBool, Ordering};
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

/// NSEventModifierFlagFunction = 1 << 23.
#[cfg(target_os = "macos")]
const FN_FLAG: u64 = 0x800000;

/// Minimum Fn hold before we treat the press as a real dictation. A brush under
/// this just flips the recognizer on and off with no paste — same failure mode
/// as aqua's FN_TAP_PRIMER_MAX_MS.
#[cfg(target_os = "macos")]
const FN_TAP_PRIMER_MAX_MS: u64 = 220;

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
                let _ = app.emit(
                    "o8:stt-event",
                    serde_json::json!({ "type": "system-start", "origin": "system" }),
                );
            }
        });
    }

    match crate::stt_engine::start() {
        Ok(sid) => tracing::info!("[fn-hotkey] system dictation started (session={sid})"),
        Err(e) => {
            tracing::error!("[fn-hotkey] failed to start dictation: {e}");
            set_system_origin(false);
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
    if let Some(app) = APP_HANDLE.get() {
        let app = app.clone();
        let _ = app.run_on_main_thread({
            let app = app.clone();
            move || {
                let _ = app.emit(
                    "o8:stt-event",
                    serde_json::json!({ "type": "system-idle", "origin": "system" }),
                );
            }
        });
    }
}

/// End a system-origin dictation. The finalize chain (Whisper → polish → paste)
/// fires off the daemon's final/audio_file stdout events; the origin branch in
/// `run_finalize` routes the polished text to `paste::paste_text`.
#[cfg(target_os = "macos")]
fn end_system_dictation() {
    if let Err(e) = crate::stt_engine::stop() {
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
    let _ = crate::stt_engine::stop();
    morph_dock_idle();
}

/// Spawn the global Fn hotkey monitor. Call ONCE from `setup()` alongside
/// `stt_engine::spawn`. On non-macOS this is a no-op.
#[cfg(target_os = "macos")]
pub fn start(app: tauri::AppHandle) {
    use core_graphics::event::{
        CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement, CGEventType,
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
                    // Push-to-talk only: KeyDown events are ignored entirely.
                    if matches!(event_type, CGEventType::KeyDown) {
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
                        std::thread::spawn(begin_system_dictation);
                    } else if up_edge {
                        let press_time = fn_press_time_cb
                            .lock()
                            .map(|t| *t)
                            .unwrap_or_else(|_| std::time::Instant::now());
                        let hold = std::time::Instant::now().duration_since(press_time);
                        if hold < std::time::Duration::from_millis(FN_TAP_PRIMER_MAX_MS) {
                            // Sub-threshold brush — tear down silently, no paste.
                            std::thread::spawn(discard_brush);
                        } else {
                            std::thread::spawn(end_system_dictation);
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
