//! macOS permission-query helpers for the system-wide voice path.
//!
//! Lifted from aqua/Symon and de-Symonized. The global Fn `CGEventTap` (see
//! `fn_hotkey.rs`) needs TWO separate TCC grants that macOS treats independently:
//!
//!   1. **Accessibility** (`AXIsProcessTrustedWithOptions`) — without it the tap
//!      is created successfully but never fires.
//!   2. **Input Monitoring** (`IOHIDCheckAccess`) — stricter and separate; without
//!      it the tap receives ZERO events under the hardened runtime even when
//!      Accessibility is granted. New users who grant only Accessibility hit
//!      exactly this ("Fn does nothing, no error").
//!
//! A third helper reads `AppleFnUsageType`: macOS Sequoia ships it unset, which
//! the OS treats as "Start Dictation" — Apple's own dictation intercepts the Fn
//! press before our tap can react. Surfacing this lets onboarding nudge the user
//! to set System Settings → Keyboard → "Press 🌐 key to → Do Nothing".

/// Check whether this process has macOS Accessibility permission. When `prompt`
/// is true, this triggers the native system dialog that opens System Settings →
/// Privacy & Security → Accessibility with o8 highlighted (first-launch flow).
///
/// Returns `true` if Accessibility is (now) granted, `false` otherwise.
#[cfg(target_os = "macos")]
pub(crate) fn accessibility_permission_granted(prompt: bool) -> bool {
    use core_foundation::base::TCFType;
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
    use core_foundation::string::{CFString, CFStringRef};

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> bool;
        static kAXTrustedCheckOptionPrompt: CFStringRef;
    }

    unsafe {
        let prompt_key = CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt);
        let prompt_value = if prompt {
            CFBoolean::true_value()
        } else {
            CFBoolean::false_value()
        };
        let options =
            CFDictionary::from_CFType_pairs(&[(prompt_key.as_CFType(), prompt_value.as_CFType())]);
        AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef())
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn accessibility_permission_granted(_prompt: bool) -> bool {
    true
}

/// Input Monitoring (`kTCCServiceListenEvent`) — REQUIRED for the keyboard
/// CGEventTap to actually receive Fn / key events. This is SEPARATE from and
/// stricter than Accessibility: without it the tap is created successfully but
/// receives nothing, so "Fn does nothing" with no error. `prompt = true`
/// triggers the macOS approval dialog (and returns the resulting grant state).
#[cfg(target_os = "macos")]
pub(crate) fn input_monitoring_granted(prompt: bool) -> bool {
    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOHIDCheckAccess(request: u32) -> u32;
        fn IOHIDRequestAccess(request: u32) -> bool;
    }
    // kIOHIDRequestTypeListenEvent = 1; kIOHIDAccessTypeGranted = 0.
    const LISTEN_EVENT: u32 = 1;
    const GRANTED: u32 = 0;
    unsafe {
        if prompt {
            return IOHIDRequestAccess(LISTEN_EVENT);
        }
        IOHIDCheckAccess(LISTEN_EVENT) == GRANTED
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn input_monitoring_granted(_prompt: bool) -> bool {
    true
}

/// Read `com.apple.HIToolbox AppleFnUsageType` — the system setting for
/// "Press 🌐 key to" in System Settings → Keyboard. macOS Sequoia ships this
/// unset, which the OS treats as `3` ("Start Dictation"): pressing Fn fires
/// Apple Dictation and o8's CGEvent tap never sees a clean flag-change.
///
/// Returns `Some(0..)` if the default can be parsed, `None` if it is unset or
/// unreadable (treat unset as `3` — the OS default).
#[cfg(target_os = "macos")]
pub(crate) fn fn_key_usage_type() -> Option<u32> {
    let output = std::process::Command::new("defaults")
        .args(["read", "com.apple.HIToolbox", "AppleFnUsageType"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    std::str::from_utf8(&output.stdout)
        .ok()?
        .trim()
        .parse::<u32>()
        .ok()
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn fn_key_usage_type() -> Option<u32> {
    None
}

/// Screen Recording (`kTCCServiceScreenCapture`) — powers Symon's screen sight
/// (Points / Guide / "what's on my screen"). KNOWN CAVEAT: after an app-bundle
/// rebind `CGPreflightScreenCaptureAccess` can return stale truth (the pane
/// says ON, capture fails) — the fix is a fresh grant after
/// `tccutil reset ScreenCapture ai.o8.desktop`. As a *displayed status* this is
/// still the best probe available; the capture path itself is attempt-first.
#[cfg(target_os = "macos")]
pub(crate) fn screen_capture_granted() -> bool {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
    }
    unsafe { CGPreflightScreenCaptureAccess() }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn screen_capture_granted() -> bool {
    true
}

/// Microphone TCC status via `AVCaptureDevice authorizationStatusForMediaType:`
/// (AVFoundation force-linked just for this lookup; the class is resolved at
/// runtime so no objc2-av-foundation crate is needed). Returns `Some(true)`
/// authorized, `Some(false)` denied/restricted, `None` when the user was never
/// asked (notDetermined — the first dictation will prompt).
#[cfg(target_os = "macos")]
pub(crate) fn mic_permission_granted() -> Option<bool> {
    use objc2::msg_send;
    use objc2::runtime::AnyClass;
    use objc2_foundation::NSString;

    // Force-link AVFoundation so AVCaptureDevice exists in the runtime.
    #[link(name = "AVFoundation", kind = "framework")]
    extern "C" {}

    let cls = AnyClass::get(c"AVCaptureDevice")?;
    // AVMediaTypeAudio == "soun" (the constant's value; avoids binding the
    // extern NSString constant).
    let media = NSString::from_str("soun");
    // AVAuthorizationStatus: 0 notDetermined, 1 restricted, 2 denied, 3 authorized.
    let status: isize = unsafe { msg_send![cls, authorizationStatusForMediaType: &*media] };
    match status {
        3 => Some(true),
        0 => None,
        _ => Some(false),
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn mic_permission_granted() -> Option<bool> {
    Some(true)
}

/// Explicitly drive the macOS Microphone permission prompt via
/// `AVCaptureDevice requestAccessForMediaType:completionHandler:`, so the OS
/// dialog is deterministic instead of relying on the first mic capture to
/// trigger it (#1537-adjacent). Call from the dictation setup path at boot.
///
/// Guarded two ways: it runs at most ONCE per app run (a `Once`), and it only
/// prompts when the status is `notDetermined` — an already-authorized or
/// already-denied grant short-circuits (re-requesting a denial is a silent
/// no-op; re-requesting an authorization is wasted work). The completion
/// handler just logs the outcome; the dictation path re-checks status when it
/// actually captures.
#[cfg(target_os = "macos")]
pub(crate) fn request_mic_access_once() {
    use std::sync::Once;
    static REQUESTED: Once = Once::new();
    REQUESTED.call_once(|| {
        // Only prompt when the user was never asked (None == notDetermined).
        if mic_permission_granted().is_some() {
            return;
        }
        use block2::RcBlock;
        use objc2::msg_send;
        use objc2::runtime::{AnyClass, Bool};
        use objc2_foundation::NSString;

        // Force-link AVFoundation so AVCaptureDevice exists in the runtime.
        #[link(name = "AVFoundation", kind = "framework")]
        extern "C" {}

        let Some(cls) = AnyClass::get(c"AVCaptureDevice") else {
            return;
        };
        // AVMediaTypeAudio == "soun".
        let media = NSString::from_str("soun");
        // The completion handler fires on an arbitrary queue after the user
        // answers. RcBlock is retained by AVFoundation for the call, so it
        // outlives this function; our reference drops here harmlessly.
        let handler = RcBlock::new(|granted: Bool| {
            log::info!(
                "[voice] microphone access request resolved: granted={}",
                granted.as_bool()
            );
        });
        let _: () = unsafe {
            msg_send![cls, requestAccessForMediaType: &*media, completionHandler: &*handler]
        };
        log::info!("[voice] requested microphone access (status was notDetermined)");
    });
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn request_mic_access_once() {}

// ── Tauri commands (frontend onboarding / permission-recovery surface) ──

/// Whether o8 has macOS Accessibility permission. Non-prompting — safe to poll.
#[tauri::command]
pub fn accessibility_permission_granted_cmd() -> bool {
    accessibility_permission_granted(false)
}

/// Whether o8 has macOS Input Monitoring permission. Non-prompting.
#[tauri::command]
pub fn input_monitoring_granted_cmd() -> bool {
    input_monitoring_granted(false)
}

/// Request Input Monitoring via `IOHIDRequestAccess` — the ONE call that
/// actually presents the macOS prompt (a listen-only tap never triggers it on
/// its own, #1537). Silent no-op returning false when the user already denied;
/// returns the resulting grant state. For the permissions surface's fix flow.
#[tauri::command]
pub fn request_input_monitoring_cmd() -> bool {
    input_monitoring_granted(true)
}

/// The current `AppleFnUsageType` (0 = Do Nothing — the value o8 needs; an unset
/// / unreadable value returns null and should be treated as 3 = Start Dictation,
/// which hijacks the Fn key).
#[tauri::command]
pub fn fn_key_usage_type_cmd() -> Option<u32> {
    fn_key_usage_type()
}

/// Whether o8 has macOS Screen Recording permission (per CGPreflight — can be
/// stale after an app rebind; see `screen_capture_granted`). Non-prompting.
#[tauri::command]
pub fn screen_capture_granted_cmd() -> bool {
    screen_capture_granted()
}

/// Microphone TCC status: true authorized, false denied/restricted, null when
/// never asked (first dictation will prompt). Non-prompting.
#[tauri::command]
pub fn mic_permission_granted_cmd() -> Option<bool> {
    mic_permission_granted()
}
