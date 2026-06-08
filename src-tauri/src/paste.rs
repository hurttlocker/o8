//! Clipboard + simulated paste for o8.
//!
//! Lifted wholesale from aqua/Symon and de-Symonized. Captures the frontmost
//! app before dictation starts, then reactivates it and pastes on Fn release.

// Several helpers (read_selected_text_via_accessibility, simulate_cmd_c,
// read_clipboard_text, activate_frontmost_app, …) are part of the verbatim
// lift but not all wired into a caller in P0-P2. Keep them so the module stays
// faithful to the source; allow dead_code rather than deleting public API.
#![allow(dead_code)]

use std::process::Command;
use std::sync::Mutex;

/// o8's own bundle ID — used to exclude ourselves from "current frontmost" checks.
const O8_BUNDLE_ID: &str = "ai.o8.desktop";
// Only applied when activation actually shifted focus (cold app switch); 12ms
// was occasionally too short for macOS to finish raising the target window
// before Cmd+V, dropping the paste.
const FOCUS_SETTLE_MS: u64 = 35;
const COMMAND_KEY_GAP_MS: u64 = 12;

/// Check if a bundle ID looks like o8 (or is invalid/garbage from the dev binary).
/// In dev mode, the raw `target/debug/o8` binary isn't a proper .app bundle so
/// System Events returns "missing value" for its bundle identifier. Any ID that
/// matches o8's real bundle ID or doesn't look like a valid reverse-DNS bundle
/// ID (no dot) is treated as "this is o8".
fn is_o8_or_invalid(bid: &str) -> bool {
    bid == O8_BUNDLE_ID || bid == "missing value" || bid.is_empty() || !bid.contains('.')
}

/// Stores the bundle ID and window info of the app active before dictation.
static PREVIOUS_APP: Mutex<Option<SavedApp>> = Mutex::new(None);

#[derive(Clone, Debug)]
struct SavedApp {
    bundle_id: String,
    process_id: i32,
}

#[cfg(target_os = "macos")]
#[derive(Clone, Debug)]
struct FrontmostAppInfo {
    bundle_id: String,
    process_id: i32,
}

#[cfg(target_os = "macos")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ActivationOutcome {
    FocusShifted,
    FocusUnchanged,
}

#[cfg(target_os = "macos")]
impl ActivationOutcome {
    fn needs_focus_settle(self) -> bool {
        matches!(self, Self::FocusShifted)
    }
}

#[cfg(target_os = "macos")]
#[derive(Clone, Debug)]
pub(crate) struct ClipboardSnapshot {
    pub(crate) text: Option<String>,
    pub(crate) change_count: i64,
}

#[cfg(target_os = "macos")]
type AXUIElementRef = core_foundation::base::CFTypeRef;

#[cfg(target_os = "macos")]
const AX_ERROR_SUCCESS: i32 = 0;

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXUIElementCreateSystemWide() -> AXUIElementRef;
    fn AXUIElementCreateApplication(pid: libc::pid_t) -> AXUIElementRef;
    fn AXUIElementCopyAttributeValue(
        element: AXUIElementRef,
        attribute: core_foundation::string::CFStringRef,
        value: *mut core_foundation::base::CFTypeRef,
    ) -> i32;
    fn AXUIElementPerformAction(
        element: AXUIElementRef,
        action: core_foundation::string::CFStringRef,
    ) -> i32;
    fn AXUIElementSetMessagingTimeout(element: AXUIElementRef, timeout_in_seconds: f32) -> i32;
}

// ─── Main-thread dispatch for AX / NSRunningApplication calls ────────────────
// macOS 15.7+ enforces main-thread-only on NSWMWindowCoordinator, which both
// AXUIElementPerformAction(AXRaise) and NSRunningApplication.activate route
// through. Calling either from the STT-event background thread produces a
// SIGILL with "Must only be used from the main thread" (confirmed in Sydney's
// v0.1.4 crash report). Earlier macOS versions were lenient, so the bug was
// invisible on our dev machines until one user hit a newer build.
//
// We trampoline through libdispatch's main queue. dispatch_sync is safe to
// call from any non-main thread; we guard against the main-thread case to
// avoid deadlocking the run loop against itself.
#[cfg(target_os = "macos")]
extern "C" {
    // `dispatch_get_main_queue()` is an inline helper in modern SDK headers —
    // it doesn't exist as a linkable symbol. The real main queue is the
    // `_dispatch_main_q` global exported by libdispatch (libSystem).
    static _dispatch_main_q: std::ffi::c_void;
    fn dispatch_sync_f(
        queue: *mut std::ffi::c_void,
        context: *mut std::ffi::c_void,
        work: extern "C" fn(*mut std::ffi::c_void),
    );
    fn pthread_main_np() -> libc::c_int;
}

#[cfg(target_os = "macos")]
#[inline]
fn dispatch_main_queue() -> *mut std::ffi::c_void {
    unsafe { &_dispatch_main_q as *const _ as *mut _ }
}

#[cfg(target_os = "macos")]
fn run_on_main_thread<F, R>(work: F) -> R
where
    F: FnOnce() -> R,
    R: Default,
{
    // Fast path: already on main thread. No dispatch_sync — would deadlock.
    if unsafe { pthread_main_np() } != 0 {
        return work();
    }

    struct Ctx<F, R> {
        work: Option<F>,
        result: Option<R>,
    }

    extern "C" fn trampoline<F, R>(ctx_ptr: *mut std::ffi::c_void)
    where
        F: FnOnce() -> R,
    {
        // Safety: ctx_ptr is a valid &mut Ctx<F, R> from the dispatch_sync
        // call site; dispatch_sync blocks the caller until we return, so the
        // reference outlives the trampoline.
        let ctx = unsafe { &mut *(ctx_ptr as *mut Ctx<F, R>) };
        if let Some(f) = ctx.work.take() {
            ctx.result = Some(f());
        }
    }

    let mut ctx = Ctx::<F, R> {
        work: Some(work),
        result: None,
    };
    unsafe {
        dispatch_sync_f(
            dispatch_main_queue(),
            &mut ctx as *mut Ctx<F, R> as *mut _,
            trampoline::<F, R>,
        );
    }
    ctx.result.unwrap_or_default()
}

#[cfg(target_os = "macos")]
struct OwnedAxElement(AXUIElementRef);

#[cfg(target_os = "macos")]
impl OwnedAxElement {
    fn new(ptr: AXUIElementRef) -> Option<Self> {
        if ptr.is_null() {
            None
        } else {
            Some(Self(ptr))
        }
    }

    fn as_ptr(&self) -> AXUIElementRef {
        self.0
    }
}

#[cfg(target_os = "macos")]
impl Drop for OwnedAxElement {
    fn drop(&mut self) {
        unsafe {
            core_foundation::base::CFRelease(self.0);
        }
    }
}

#[cfg(target_os = "macos")]
fn ax_name(name: &'static str) -> core_foundation::string::CFString {
    core_foundation::string::CFString::from_static_string(name)
}

/// Get the bundle ID of the saved frontmost app, if available.
pub fn get_frontmost_bundle_id() -> Option<String> {
    PREVIOUS_APP
        .lock()
        .ok()?
        .as_ref()
        .map(|app| app.bundle_id.clone())
}

/// Query the CURRENT frontmost app's bundle ID right now (not the saved one).
/// Used at paste time to detect if the user clicked a different app during dictation.
#[cfg(target_os = "macos")]
fn get_current_frontmost_bundle_id() -> Option<String> {
    native_frontmost_app_info().map(|app| app.bundle_id)
}

/// Save the currently focused app and its focused window (call BEFORE showing the pill).
/// Uses NSWorkspace to get the frontmost app — works correctly across multiple displays.
#[cfg(target_os = "macos")]
pub fn save_frontmost_app() {
    if let Some(app) = native_frontmost_app_info() {
        if is_o8_or_invalid(&app.bundle_id) {
            tracing::debug!(
                "paste: frontmost app is o8 ({}) — preserving previous paste target",
                app.bundle_id
            );
            return;
        }

        tracing::debug!(
            "paste: saved frontmost app: {} (pid={})",
            app.bundle_id,
            app.process_id
        );
        if let Ok(mut prev) = PREVIOUS_APP.lock() {
            *prev = Some(SavedApp {
                bundle_id: app.bundle_id,
                process_id: app.process_id,
            });
        }
    } else {
        tracing::warn!("paste: could not determine frontmost app");
    }
}

#[cfg(target_os = "macos")]
fn native_frontmost_app_info() -> Option<FrontmostAppInfo> {
    use objc2_app_kit::NSWorkspace;

    let workspace = NSWorkspace::sharedWorkspace();
    let app = workspace.frontmostApplication()?;
    let bundle_id = app.bundleIdentifier()?;
    let process_id = app.processIdentifier();
    let bid = bundle_id.to_string();
    if bid.is_empty() || process_id <= 0 {
        None
    } else {
        Some(FrontmostAppInfo {
            bundle_id: bid,
            process_id,
        })
    }
}

#[cfg(target_os = "macos")]
fn ax_copy_attribute_value(
    element: AXUIElementRef,
    attribute: core_foundation::string::CFStringRef,
) -> Option<core_foundation::base::CFType> {
    use core_foundation::base::{CFType, TCFType};

    let mut value = std::ptr::null();
    let result = unsafe { AXUIElementCopyAttributeValue(element, attribute, &mut value) };
    if result != AX_ERROR_SUCCESS || value.is_null() {
        return None;
    }
    Some(unsafe { CFType::wrap_under_create_rule(value) })
}

#[cfg(target_os = "macos")]
fn native_raise_front_window(process_id: i32) -> bool {
    // AXUIElementPerformAction(AXRaise) routes through NSWMWindowCoordinator
    // which macOS 15.7+ refuses to run off the main thread (SIGILL). Hop over.
    run_on_main_thread(move || {
        use core_foundation::base::TCFType;

        let Some(app) = OwnedAxElement::new(unsafe { AXUIElementCreateApplication(process_id) })
        else {
            return false;
        };
        unsafe {
            let _ = AXUIElementSetMessagingTimeout(app.as_ptr(), 0.2);
        }
        let focused_window_attr = ax_name("AXFocusedWindow");
        let main_window_attr = ax_name("AXMainWindow");
        let window =
            ax_copy_attribute_value(app.as_ptr(), focused_window_attr.as_concrete_TypeRef())
                .or_else(|| {
                    ax_copy_attribute_value(app.as_ptr(), main_window_attr.as_concrete_TypeRef())
                });
        let Some(window) = window else {
            return false;
        };
        let raise_action = ax_name("AXRaise");
        unsafe {
            AXUIElementPerformAction(window.as_CFTypeRef(), raise_action.as_concrete_TypeRef())
                == AX_ERROR_SUCCESS
        }
    })
}

#[cfg(target_os = "macos")]
pub(crate) fn read_selected_text_via_accessibility() -> Option<String> {
    use core_foundation::base::TCFType;

    let system = OwnedAxElement::new(unsafe { AXUIElementCreateSystemWide() })?;
    unsafe {
        let _ = AXUIElementSetMessagingTimeout(system.as_ptr(), 0.2);
    }
    let focused_attr = ax_name("AXFocusedUIElement");
    let focused_element =
        ax_copy_attribute_value(system.as_ptr(), focused_attr.as_concrete_TypeRef())?;
    let selected_attr = ax_name("AXSelectedText");
    let selected_text = ax_copy_attribute_value(
        focused_element.as_CFTypeRef(),
        selected_attr.as_concrete_TypeRef(),
    )?;
    selected_text
        .downcast::<core_foundation::string::CFString>()
        .map(|value| value.to_string())
        .filter(|text| !text.trim().is_empty())
}

/// Text context gathered from the focused app via macOS Accessibility APIs.
/// Feeds Gemini polish so it can spell on-screen names, resolve pronouns,
/// and match the surrounding conversation's tone — without a screenshot.
#[derive(Debug, Default, Clone)]
pub struct WindowContext {
    /// Title of the focused window (e.g. "Messages — Sydney", "lib.rs — o8").
    pub window_title: Option<String>,
    /// Whatever the user has highlighted in the focused element. Gold signal
    /// when present — the user explicitly told us what matters.
    pub selected_text: Option<String>,
    /// A compact dump of visible text from the focused window's AX tree.
    /// Capped at MAX_EXCERPT bytes and depth ~4 to keep the prompt small.
    /// Empty for canvas/Electron apps that don't expose AX text; callers
    /// can fall back to a screenshot in that case.
    pub ax_excerpt: Option<String>,
}

/// Hard budget on the AX text excerpt. Anything over this gets truncated —
/// Gemini has a context window but our polish latency is dominated by upload
/// bytes, so smaller is faster.
#[cfg(target_os = "macos")]
const MAX_EXCERPT: usize = 3000;

/// Max depth we'll descend when walking the AX tree. A focused chat window
/// typically surfaces useful text within 3-4 levels; deeper tends to be
/// sidebar/toolbar chrome we don't care about.
#[cfg(target_os = "macos")]
const MAX_AX_DEPTH: usize = 4;

/// Gather text context from the currently-frontmost app. Must run on the
/// main thread (AX APIs assert this on macOS 15.7+). Called from the Fn-press
/// worker thread, so we hop via run_on_main_thread.
#[cfg(target_os = "macos")]
pub fn gather_window_context() -> WindowContext {
    run_on_main_thread(|| {
        use core_foundation::base::{CFType, TCFType};
        use core_foundation::string::CFString;

        let system = match OwnedAxElement::new(unsafe { AXUIElementCreateSystemWide() }) {
            Some(s) => s,
            None => return WindowContext::default(),
        };
        unsafe {
            let _ = AXUIElementSetMessagingTimeout(system.as_ptr(), 0.2);
        }

        // Focused element → for selected_text
        let focused_attr = ax_name("AXFocusedUIElement");
        let focused = ax_copy_attribute_value(system.as_ptr(), focused_attr.as_concrete_TypeRef());
        let selected_text = focused.as_ref().and_then(|focused_el| {
            let selected_attr = ax_name("AXSelectedText");
            let raw = ax_copy_attribute_value(
                focused_el.as_CFTypeRef(),
                selected_attr.as_concrete_TypeRef(),
            )?;
            raw.downcast::<CFString>()
                .map(|v| v.to_string())
                .filter(|t| !t.trim().is_empty())
        });

        // Focused window of the frontmost app → for title + AX tree walk
        let focused_app_attr = ax_name("AXFocusedApplication");
        let focused_app =
            ax_copy_attribute_value(system.as_ptr(), focused_app_attr.as_concrete_TypeRef());
        let window = focused_app.as_ref().and_then(|app| {
            let focused_window_attr = ax_name("AXFocusedWindow");
            ax_copy_attribute_value(
                app.as_CFTypeRef(),
                focused_window_attr.as_concrete_TypeRef(),
            )
            .or_else(|| {
                let main_window_attr = ax_name("AXMainWindow");
                ax_copy_attribute_value(app.as_CFTypeRef(), main_window_attr.as_concrete_TypeRef())
            })
        });

        let window_title = window.as_ref().and_then(|w| {
            let title_attr = ax_name("AXTitle");
            let raw = ax_copy_attribute_value(w.as_CFTypeRef(), title_attr.as_concrete_TypeRef())?;
            raw.downcast::<CFString>()
                .map(|v| v.to_string())
                .filter(|t| !t.trim().is_empty())
        });

        // AX tree text walk. Depth-first, collects AXStaticText values and any
        // AXValue strings we stumble on. Caps at MAX_EXCERPT bytes to keep the
        // payload small. Returns None when the tree yields nothing useful
        // (canvas apps, Electron with opaque AX) — caller can fall back to
        // the screenshot path.
        fn walk(element: &CFType, depth: usize, out: &mut String) {
            if out.len() >= MAX_EXCERPT || depth > MAX_AX_DEPTH {
                return;
            }
            let role_attr = ax_name("AXRole");
            let role =
                ax_copy_attribute_value(element.as_CFTypeRef(), role_attr.as_concrete_TypeRef())
                    .and_then(|r| r.downcast::<CFString>().map(|v| v.to_string()))
                    .unwrap_or_default();

            let is_text_bearing = matches!(
                role.as_str(),
                "AXStaticText" | "AXTextField" | "AXTextArea" | "AXValueIndicator"
            );
            if is_text_bearing {
                let value_attr = ax_name("AXValue");
                if let Some(raw) = ax_copy_attribute_value(
                    element.as_CFTypeRef(),
                    value_attr.as_concrete_TypeRef(),
                ) {
                    if let Some(s) = raw.downcast::<CFString>().map(|v| v.to_string()) {
                        let trimmed = s.trim();
                        if !trimmed.is_empty() && out.len() + trimmed.len() < MAX_EXCERPT {
                            if !out.is_empty() {
                                out.push('\n');
                            }
                            out.push_str(trimmed);
                        }
                    }
                }
            }

            let children_attr = ax_name("AXChildren");
            if let Some(raw_children) =
                ax_copy_attribute_value(element.as_CFTypeRef(), children_attr.as_concrete_TypeRef())
            {
                // The raw children array is a CFArray of AXUIElementRef
                // pointers (i.e. CFType-erased). core-foundation's
                // CFArray<T> only works for T: ConcreteCFType, which
                // CFType itself is not. Drop to the untyped CFArray and
                // pull child refs directly via CFArrayGetValueAtIndex.
                use core_foundation::array::{CFArrayGetCount, CFArrayGetValueAtIndex, CFArrayRef};
                let arr_ref = raw_children.as_CFTypeRef() as CFArrayRef;
                let count = unsafe { CFArrayGetCount(arr_ref) };
                for i in 0..count {
                    if out.len() >= MAX_EXCERPT {
                        break;
                    }
                    let ptr = unsafe { CFArrayGetValueAtIndex(arr_ref, i) };
                    if ptr.is_null() {
                        continue;
                    }
                    let child = unsafe {
                        CFType::wrap_under_get_rule(ptr as core_foundation::base::CFTypeRef)
                    };
                    walk(&child, depth + 1, out);
                }
            }
        }

        let ax_excerpt = window.as_ref().and_then(|w| {
            let mut buf = String::new();
            walk(w, 0, &mut buf);
            let trimmed = buf.trim();
            if trimmed.len() < 40 {
                None
            } else {
                Some(trimmed.to_string())
            }
        });

        WindowContext {
            window_title,
            selected_text,
            ax_excerpt,
        }
    })
}

#[cfg(not(target_os = "macos"))]
pub fn gather_window_context() -> WindowContext {
    WindowContext::default()
}

/// Reactivate the previously saved app and raise its window.
/// Uses `activate` + `set index of window 1` to ensure the correct window
/// comes to front, even on multi-display setups.
#[cfg(target_os = "macos")]
fn reactivate_previous_app() -> ActivationOutcome {
    let saved = {
        let prev = PREVIOUS_APP.lock().unwrap();
        prev.clone()
    };

    if let Some(app) = saved {
        if native_activate_app(&app) {
            if native_raise_front_window(app.process_id) {
                tracing::debug!(
                    "paste: raised {} via AX (pid={})",
                    app.bundle_id,
                    app.process_id
                );
            }
            tracing::debug!(
                "paste: reactivated {} via NSRunningApplication (pid={})",
                app.bundle_id,
                app.process_id
            );
            return ActivationOutcome::FocusShifted;
        }

        let fallback = format!(r#"tell application id "{}" to activate"#, app.bundle_id);
        match Command::new("osascript").args(["-e", &fallback]).output() {
            Ok(out) if out.status.success() => {
                tracing::debug!(
                    "paste: reactivated {} via AppleScript fallback",
                    app.bundle_id
                );
                return ActivationOutcome::FocusShifted;
            }
            Ok(out) => {
                tracing::warn!(
                    "paste: AppleScript activate fallback failed for {}: {}",
                    app.bundle_id,
                    String::from_utf8_lossy(&out.stderr)
                );
            }
            Err(e) => {
                tracing::warn!("paste: failed to reactivate {}: {e}", app.bundle_id);
            }
        }
    }
    ActivationOutcome::FocusUnchanged
}

#[cfg(target_os = "macos")]
fn native_activate_app(app: &SavedApp) -> bool {
    // NSRunningApplication.activateWithOptions is also main-thread-only on
    // macOS 15.7+ (same NSWMWindowCoordinator path as AXRaise). Copy the
    // SavedApp fields the closure needs — `app` is borrowed but the closure
    // needs 'static data for dispatch_sync.
    let process_id = app.process_id;
    let bundle_id = app.bundle_id.clone();
    run_on_main_thread(move || {
        use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication};
        use objc2_foundation::NSString;

        if let Some(app_ref) =
            NSRunningApplication::runningApplicationWithProcessIdentifier(process_id)
        {
            let _ = app_ref.unhide();
            if app_ref.activateWithOptions(NSApplicationActivationOptions::ActivateAllWindows) {
                return true;
            }
        }

        let ns_bundle_id = NSString::from_str(&bundle_id);
        let apps = NSRunningApplication::runningApplicationsWithBundleIdentifier(&ns_bundle_id);
        if apps.count() == 0 {
            return false;
        }

        let app_ref = apps.objectAtIndex(0);
        let _ = app_ref.unhide();
        app_ref.activateWithOptions(NSApplicationActivationOptions::ActivateAllWindows)
    })
}

/// Determine the correct paste target and activate it.
///
/// If the user clicked a different app or window during dictation, paste there
/// instead of re-activating the stale target from Fn-press time.
#[cfg(target_os = "macos")]
fn smart_activate() -> ActivationOutcome {
    let current_info = native_frontmost_app_info();
    let current = current_info.as_ref().map(|app| app.bundle_id.clone());
    let saved = get_frontmost_bundle_id();

    match (&current, &saved) {
        // Current frontmost is a real app (not o8) and differs from saved:
        // user clicked somewhere new during dictation — paste there.
        (Some(cur), Some(sav)) if cur != sav && !is_o8_or_invalid(cur) => {
            tracing::info!(
                "paste: user clicked {cur} during dictation (saved was {sav}) — preserving current focused window"
            );
            ActivationOutcome::FocusUnchanged
        }
        // Current frontmost IS o8 (or invalid/dev binary) — use saved app.
        (Some(cur), _) if is_o8_or_invalid(cur) => {
            tracing::debug!("paste: frontmost is o8 ({cur}) — reactivating saved app");
            reactivate_previous_app()
        }
        // Current already matches the saved target — keep the app where it is.
        (Some(cur), Some(sav)) if cur == sav && !is_o8_or_invalid(cur) => {
            tracing::debug!(
                "paste: target app already frontmost ({cur}) — preserving current focused window"
            );
            ActivationOutcome::FocusUnchanged
        }
        // Current matches saved, or we can't tell — normal reactivation.
        _ => reactivate_previous_app(),
    }
}

/// Activate the saved frontmost app (bring to front) WITHOUT pasting.
///
/// Call this at the moment polish starts so macOS can complete activation
/// in parallel with Gemini inference. If the user has already clicked a
/// different app, skip pre-activation to avoid a visible focus-jump back
/// to the stale target — `paste_text()` will sort it out at paste time.
#[cfg(target_os = "macos")]
pub fn activate_frontmost_app() -> bool {
    let current = get_current_frontmost_bundle_id();
    let saved = get_frontmost_bundle_id();

    match (&current, &saved) {
        (Some(cur), Some(sav)) if cur != sav && !is_o8_or_invalid(cur) => {
            tracing::info!("paste: skipping pre-activate — user clicked {cur} (saved was {sav})");
            true
        }
        (Some(cur), Some(sav)) if cur == sav && !is_o8_or_invalid(cur) => true,
        _ => matches!(reactivate_previous_app(), ActivationOutcome::FocusShifted),
    }
}

/// No-op on non-macOS platforms.
#[cfg(not(target_os = "macos"))]
pub fn activate_frontmost_app() -> bool {
    false
}

/// Copy `text` to the macOS pasteboard, activate the correct target app, and simulate Cmd+V.
///
/// Smart target resolution: if the user clicked a different app during the
/// Fn hold (or during polishing), paste goes to THAT app instead of the
/// stale target saved at Fn-press time.
///
/// Clipboard is saved before and restored after (plain-text only) so we
/// don't clobber whatever the user had copied previously.
#[cfg(target_os = "macos")]
pub fn paste_text(text: &str) {
    if text.is_empty() {
        tracing::debug!("paste: skipping — empty text");
        return;
    }

    // Step 0: Save current clipboard for later restoration.
    let saved_clipboard = capture_clipboard_snapshot();

    // Step 1: Write text to clipboard.
    let injected_change_count = match copy_to_clipboard(text) {
        Ok(change_count) => change_count,
        Err(e) => {
            tracing::error!("paste: failed to copy to clipboard: {e}");
            return;
        }
    };

    // Step 2: Activate the correct paste target. If the user clicked a
    // different app during dictation, smart_activate() detects this and
    // pastes there instead of the stale saved target.
    let activation = smart_activate();

    // Step 3: Tiny safety sleep to ensure keyboard focus is live before
    // we post the synthetic Cmd+V. Keep this below one frame: pre-activation
    // already handled the slow part, and anything longer is directly visible
    // on the release path.
    if activation.needs_focus_settle() {
        std::thread::sleep(std::time::Duration::from_millis(FOCUS_SETTLE_MS));
    }

    // Step 4: Simulate Cmd+V.
    simulate_cmd_v();

    tracing::debug!("paste: wrote {} chars to clipboard and pasted", text.len());

    // Step 5: Restore the user's original clipboard after a delay.
    //
    // The old 300ms delay was WAY too aggressive. On Intel, slow-paste-handler
    // apps (Terminal, Slack, some Electron editors) consume the clipboard 400-
    // 1500ms AFTER we post the synthetic Cmd+V, long after we'd already rolled
    // back — so the app ends up pasting the *old* clipboard content and the
    // user sees "pasting old stuff". Worse, if the user hit Cmd+V manually
    // within a second of dictation hoping to re-paste their words, they also
    // got the stale content. 5s covers both cases comfortably while still
    // eventually returning the user's previous clipboard for copy-history
    // workflows. If someone hits Cmd+C on something else during those 5s, the
    // change_count guard in restore_clipboard_if_match skips the restore.
    restore_clipboard_delayed(saved_clipboard, injected_change_count, 5000);
}

/// Write text to the system clipboard.
#[cfg(target_os = "macos")]
pub(crate) fn copy_to_clipboard(text: &str) -> Result<i64, String> {
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};
    use objc2_foundation::NSString;

    let pasteboard = NSPasteboard::generalPasteboard();
    pasteboard.clearContents();
    let text = NSString::from_str(text);
    let string_type = unsafe { NSPasteboardTypeString };
    if pasteboard.setString_forType(&text, string_type) {
        Ok(pasteboard.changeCount() as i64)
    } else {
        Err("NSPasteboard rejected string write".to_string())
    }
}

/// Save the current clipboard contents (plain text only).
#[cfg(target_os = "macos")]
pub(crate) fn capture_clipboard_snapshot() -> ClipboardSnapshot {
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};

    let pasteboard = NSPasteboard::generalPasteboard();
    let string_type = unsafe { NSPasteboardTypeString };
    ClipboardSnapshot {
        text: pasteboard
            .stringForType(string_type)
            .map(|text| text.to_string())
            .filter(|s| !s.is_empty()),
        change_count: pasteboard.changeCount() as i64,
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn clipboard_change_count() -> i64 {
    use objc2_app_kit::NSPasteboard;

    let pasteboard = NSPasteboard::generalPasteboard();
    pasteboard.changeCount() as i64
}

#[cfg(target_os = "macos")]
pub(crate) fn read_clipboard_text() -> Option<String> {
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};

    let pasteboard = NSPasteboard::generalPasteboard();
    let string_type = unsafe { NSPasteboardTypeString };
    pasteboard
        .stringForType(string_type)
        .map(|text| text.to_string())
        .filter(|s| !s.is_empty())
}

#[cfg(target_os = "macos")]
fn clear_clipboard() -> i64 {
    use objc2_app_kit::NSPasteboard;

    let pasteboard = NSPasteboard::generalPasteboard();
    pasteboard.clearContents();
    pasteboard.changeCount() as i64
}

#[cfg(target_os = "macos")]
pub(crate) fn restore_clipboard_if_match(
    snapshot: &ClipboardSnapshot,
    expected_change_count: i64,
) -> bool {
    if clipboard_change_count() != expected_change_count {
        return false;
    }
    match &snapshot.text {
        Some(text) => copy_to_clipboard(text).is_ok(),
        None => {
            clear_clipboard();
            true
        }
    }
}

/// Restore previously saved clipboard contents after a delay.
/// Spawns a background thread so it doesn't block the paste flow.
#[cfg(target_os = "macos")]
fn restore_clipboard_delayed(saved: ClipboardSnapshot, expected_change_count: i64, delay_ms: u64) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(delay_ms));
        if !restore_clipboard_if_match(&saved, expected_change_count) {
            tracing::debug!("paste: clipboard changed since paste, skipping restore");
            return;
        }
        tracing::debug!(
            "paste: clipboard restored ({} chars)",
            saved.text.as_ref().map(|text| text.len()).unwrap_or(0)
        );
    });
}

/// Simulate a Command-modified keystroke using Core Graphics events.
#[cfg(target_os = "macos")]
fn simulate_command_keypress(keycode: u16, label: &str) {
    use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation};
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

    let source = match CGEventSource::new(CGEventSourceStateID::CombinedSessionState) {
        Ok(s) => s,
        Err(()) => {
            tracing::error!("{label}: failed to create CGEventSource");
            return;
        }
    };

    let key_down = match CGEvent::new_keyboard_event(source.clone(), keycode, true) {
        Ok(e) => e,
        Err(()) => {
            tracing::error!("{label}: failed to create key-down event");
            return;
        }
    };
    key_down.set_flags(CGEventFlags::CGEventFlagCommand);

    let key_up = match CGEvent::new_keyboard_event(source, keycode, false) {
        Ok(e) => e,
        Err(()) => {
            tracing::error!("{label}: failed to create key-up event");
            return;
        }
    };
    key_up.set_flags(CGEventFlags::CGEventFlagCommand);

    key_down.post(CGEventTapLocation::HID);
    std::thread::sleep(std::time::Duration::from_millis(COMMAND_KEY_GAP_MS));
    key_up.post(CGEventTapLocation::HID);
}

/// Simulate Cmd+V keystroke using Core Graphics events.
#[cfg(target_os = "macos")]
pub(crate) fn simulate_cmd_v() {
    simulate_command_keypress(0x09, "paste");
}

/// Simulate Cmd+C keystroke using Core Graphics events.
#[cfg(target_os = "macos")]
pub(crate) fn simulate_cmd_c() {
    simulate_command_keypress(0x08, "selection");
}

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventSourceFlagsState(state_id: i32) -> u64;
}

/// Wait (≤700ms) for the ⌘ and ⇧ modifiers to be physically released before we
/// synthesize Cmd+C. Posting Cmd+C while the ⌘⇧S chord is still held merges the
/// held Shift into the event (→ Cmd+Shift+C) so the copy never happens. Matters
/// for AX-opaque surfaces (o8's own WKWebView) where Strategy 1 returns None and
/// we depend on the Cmd+C fallback. A tap releases in tens of ms; a long hold
/// times out and we proceed best-effort.
#[cfg(target_os = "macos")]
fn wait_for_chord_release() {
    // kCGEventFlagMaskCommand (1<<20) | kCGEventFlagMaskShift (1<<17).
    const CHORD_MASK: u64 = 0x100000 | 0x20000;
    // kCGEventSourceStateCombinedSessionState = 1.
    const CG_STATE_COMBINED_SESSION: i32 = 1;
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(700);
    while std::time::Instant::now() < deadline {
        let held = unsafe { CGEventSourceFlagsState(CG_STATE_COMBINED_SESSION) } & CHORD_MASK;
        if held == 0 {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

/// Read the user's current text selection (voice P4 "say" / speak-selection).
/// Strategy 1: Accessibility `AXSelectedText` (no clipboard touch). Strategy 2:
/// synthesize Cmd+C, poll the clipboard ≤180ms (10ms cadence), read it, then
/// restore the user's original clipboard. Ported from aqua/Symon
/// `reading.rs::grab_selection` — the 180ms/10ms/accept-rule are verbatim.
#[cfg(target_os = "macos")]
pub(crate) fn grab_selection() -> Option<String> {
    // ── Strategy 1: Accessibility (no clipboard clobber) ──
    // AX APIs SIGILL/return-nothing off the main thread on macOS 15.7+ (same
    // rule as gather_window_context). grab_selection is called from a worker
    // thread (the ⌘⇧S handler spawns it for the Cmd+C sleeps), so the AX read
    // MUST hop to the main thread or it silently fails and we fall through to
    // the held-modifier-broken Cmd+C path.
    if let Some(text) = run_on_main_thread(read_selected_text_via_accessibility) {
        log::info!("[tts] grab_selection: AXSelectedText got {} chars", text.len());
        return Some(text);
    }

    // ── Strategy 2: simulate Cmd+C → poll clipboard → restore ──
    // Wait for the ⌘⇧S chord to release first so the synthetic Cmd+C isn't
    // polluted by the still-held Shift (the held-modifier bug that left o8's own
    // webview selection uncopyable).
    wait_for_chord_release();
    let saved = capture_clipboard_snapshot();
    simulate_cmd_c();

    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(180);
    let mut copied_change_count = None;
    while std::time::Instant::now() < deadline {
        let current = clipboard_change_count();
        if current != saved.change_count {
            copied_change_count = Some(current);
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }

    let new_clipboard = copied_change_count.and_then(|_| read_clipboard_text());
    if let Some(change_count) = copied_change_count {
        let _ = restore_clipboard_if_match(&saved, change_count);
    }

    match (&new_clipboard, &saved.text) {
        (Some(new), Some(old)) if new != old && !new.trim().is_empty() => {
            log::info!("[tts] grab_selection: Cmd+C got {} chars", new.len());
            new_clipboard
        }
        (Some(new), None) if !new.trim().is_empty() => {
            log::info!("[tts] grab_selection: Cmd+C got {} chars (no prior clipboard)", new.len());
            new_clipboard
        }
        _ => {
            log::warn!("[tts] grab_selection: clipboard unchanged — no selection to speak");
            None
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn grab_selection() -> Option<String> {
    None
}

/// No-op on non-macOS platforms.
#[cfg(not(target_os = "macos"))]
pub fn paste_text(_text: &str) {
    tracing::warn!("paste: not supported on this platform");
}

#[cfg(not(target_os = "macos"))]
pub fn save_frontmost_app() {}

#[cfg(not(target_os = "macos"))]
#[derive(Clone, Debug, Default)]
pub(crate) struct ClipboardSnapshot {
    pub(crate) text: Option<String>,
    pub(crate) change_count: i64,
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn read_selected_text_via_accessibility() -> Option<String> {
    None
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn capture_clipboard_snapshot() -> ClipboardSnapshot {
    ClipboardSnapshot::default()
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn clipboard_change_count() -> i64 {
    0
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn read_clipboard_text() -> Option<String> {
    None
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn restore_clipboard_if_match(
    _snapshot: &ClipboardSnapshot,
    _expected_change_count: i64,
) -> bool {
    false
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn copy_to_clipboard(_text: &str) -> Result<i64, String> {
    Err("paste: clipboard unsupported on this platform".to_string())
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn simulate_cmd_v() {}

#[cfg(not(target_os = "macos"))]
pub(crate) fn simulate_cmd_c() {}
