//! Safe caret-local live dictation for the global Fn path.
//!
//! Apple Speech partials are provisional. We only paint them into the focused
//! field when Accessibility exposes a writable value AND writable selection,
//! and we verify the captured field before every replacement. Unsupported
//! targets keep the cursor-local visual preview and use the existing atomic
//! final paste path.

use core_foundation::base::{CFType, CFTypeRef, TCFType};
use core_foundation::string::{CFString, CFStringRef};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

type AXUIElementRef = CFTypeRef;

const AX_ERROR_SUCCESS: i32 = 0;
const K_AX_VALUE_TYPE_CGPOINT: u32 = 1;
const K_AX_VALUE_TYPE_CGSIZE: u32 = 2;
const K_AX_VALUE_TYPE_CGRECT: u32 = 3;
const K_AX_VALUE_TYPE_CFRANGE: u32 = 4;
const MAX_FIELD_UTF16: usize = 64 * 1024;

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct CGPoint {
    x: f64,
    y: f64,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct CGSize {
    width: f64,
    height: f64,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct CGRect {
    origin: CGPoint,
    size: CGSize,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct CFRange {
    location: isize,
    length: isize,
}

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXUIElementCreateApplication(pid: libc::pid_t) -> AXUIElementRef;
    fn AXUIElementCopyAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: *mut CFTypeRef,
    ) -> i32;
    fn AXUIElementCopyParameterizedAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        parameter: CFTypeRef,
        value: *mut CFTypeRef,
    ) -> i32;
    fn AXUIElementSetMessagingTimeout(element: AXUIElementRef, timeout_in_seconds: f32) -> i32;
    fn AXUIElementSetAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: CFTypeRef,
    ) -> i32;
    fn AXUIElementIsAttributeSettable(
        element: AXUIElementRef,
        attribute: CFStringRef,
        settable: *mut u8,
    ) -> i32;
    fn AXValueCreate(the_type: u32, value_ptr: *const std::ffi::c_void) -> CFTypeRef;
    fn AXValueGetValue(value: CFTypeRef, the_type: u32, value_ptr: *mut std::ffi::c_void) -> u8;
}

extern "C" {
    static _dispatch_main_q: std::ffi::c_void;
    fn dispatch_sync_f(
        queue: *mut std::ffi::c_void,
        context: *mut std::ffi::c_void,
        work: extern "C" fn(*mut std::ffi::c_void),
    );
    fn pthread_main_np() -> libc::c_int;
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct CaretAnchor {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PartialsSurface {
    Caret,
    Hud,
    Off,
}

impl PartialsSurface {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Caret => "caret",
            Self::Hud => "hud",
            Self::Off => "off",
        }
    }
}

pub(crate) fn configured_surface() -> PartialsSurface {
    match crate::stt::keys::config_string("dictation_partials_surface").as_deref() {
        Some("hud") => PartialsSurface::Hud,
        Some("off") => PartialsSurface::Off,
        _ => PartialsSurface::Caret,
    }
}

#[derive(Clone, Debug)]
struct Target {
    pid: i32,
    role: String,
    identifier: Option<String>,
    element_frame: Option<CGRect>,
    value: String,
    selection: CFRange,
}

#[derive(Debug)]
struct Transaction {
    session_id: Option<u64>,
    surface: PartialsSurface,
    stream_partials: bool,
    target: Option<Target>,
    anchor: Option<CaretAnchor>,
    original_value: String,
    original_selection: CFRange,
    prefix: Vec<u16>,
    suffix: Vec<u16>,
    expected_value: String,
    expected_selection: CFRange,
    inserted: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum FinishOutcome {
    Applied,
    NotHandled,
    Conflict(String),
}

static TRANSACTION: Mutex<Option<Transaction>> = Mutex::new(None);
static LATEST_PARTIAL: Mutex<Option<(u64, String)>> = Mutex::new(None);
static UPDATE_WORKER_RUNNING: AtomicBool = AtomicBool::new(false);

fn ax_name(name: &'static str) -> CFString {
    CFString::from_static_string(name)
}

fn copy_attribute(element: AXUIElementRef, name: &'static str) -> Option<CFType> {
    let mut value = std::ptr::null();
    let err = unsafe {
        AXUIElementCopyAttributeValue(element, ax_name(name).as_concrete_TypeRef(), &mut value)
    };
    if err != AX_ERROR_SUCCESS || value.is_null() {
        return None;
    }
    Some(unsafe { CFType::wrap_under_create_rule(value) })
}

fn string_attribute(element: AXUIElementRef, name: &'static str) -> Option<String> {
    copy_attribute(element, name)?
        .downcast::<CFString>()
        .map(|s| s.to_string())
}

fn is_settable(element: AXUIElementRef, name: &'static str) -> bool {
    let mut raw = 0_u8;
    unsafe {
        AXUIElementIsAttributeSettable(element, ax_name(name).as_concrete_TypeRef(), &mut raw)
            == AX_ERROR_SUCCESS
            && raw != 0
    }
}

fn ax_range(value: CFTypeRef) -> Option<CFRange> {
    let mut range = CFRange::default();
    let ok = unsafe {
        AXValueGetValue(
            value,
            K_AX_VALUE_TYPE_CFRANGE,
            &mut range as *mut _ as *mut std::ffi::c_void,
        )
    };
    (ok != 0 && range.location >= 0 && range.length >= 0).then_some(range)
}

fn ax_point(value: CFTypeRef) -> Option<CGPoint> {
    let mut point = CGPoint::default();
    let ok = unsafe {
        AXValueGetValue(
            value,
            K_AX_VALUE_TYPE_CGPOINT,
            &mut point as *mut _ as *mut std::ffi::c_void,
        )
    };
    (ok != 0).then_some(point)
}

fn ax_size(value: CFTypeRef) -> Option<CGSize> {
    let mut size = CGSize::default();
    let ok = unsafe {
        AXValueGetValue(
            value,
            K_AX_VALUE_TYPE_CGSIZE,
            &mut size as *mut _ as *mut std::ffi::c_void,
        )
    };
    (ok != 0).then_some(size)
}

fn element_frame(element: AXUIElementRef) -> Option<CGRect> {
    let position = copy_attribute(element, "AXPosition")?;
    let size = copy_attribute(element, "AXSize")?;
    let origin = ax_point(position.as_CFTypeRef())?;
    let size = ax_size(size.as_CFTypeRef())?;
    (size.width > 0.0 && size.height > 0.0).then_some(CGRect { origin, size })
}

fn range_bounds(element: AXUIElementRef, range_value: CFTypeRef) -> Option<CGRect> {
    let mut raw = std::ptr::null();
    let err = unsafe {
        AXUIElementCopyParameterizedAttributeValue(
            element,
            ax_name("AXBoundsForRange").as_concrete_TypeRef(),
            range_value,
            &mut raw,
        )
    };
    if err != AX_ERROR_SUCCESS || raw.is_null() {
        return None;
    }
    let value = unsafe { CFType::wrap_under_create_rule(raw) };
    let mut rect = CGRect::default();
    let ok = unsafe {
        AXValueGetValue(
            value.as_CFTypeRef(),
            K_AX_VALUE_TYPE_CGRECT,
            &mut rect as *mut _ as *mut std::ffi::c_void,
        )
    };
    (ok != 0 && rect.size.height > 0.0).then_some(rect)
}

fn anchor_for(element: AXUIElementRef, selection_value: Option<CFTypeRef>) -> Option<CaretAnchor> {
    let rect = selection_value
        .and_then(|value| range_bounds(element, value))
        .or_else(|| element_frame(element))?;
    Some(CaretAnchor {
        x: rect.origin.x,
        y: rect.origin.y,
        width: rect.size.width.max(1.0),
        height: rect.size.height.max(1.0),
    })
}

fn focused_element_for_pid(pid: i32) -> Option<(CFType, CFType)> {
    let app_raw = unsafe { AXUIElementCreateApplication(pid) };
    if app_raw.is_null() {
        return None;
    }
    let app = unsafe { CFType::wrap_under_create_rule(app_raw) };
    unsafe {
        let _ = AXUIElementSetMessagingTimeout(app.as_CFTypeRef(), 0.2);
    }
    let focused = copy_attribute(app.as_CFTypeRef(), "AXFocusedUIElement")?;
    Some((app, focused))
}

/// Resolve the focused editable ONCE and derive both the caret anchor and (when
/// `want_target`) the streaming target from it. This merges what used to be two
/// separate main-thread round-trips — one per derived value, each re-resolving
/// the frontmost app + focused element + selection — into a single pass. That
/// halves the dispatch_sync and AX round-trips on the pre-mic critical path, the
/// Intel mic-open latency win.
fn capture_focused_on_main(want_target: bool) -> (Option<Target>, Option<CaretAnchor>) {
    use objc2_app_kit::NSWorkspace;

    let Some(app) = NSWorkspace::sharedWorkspace().frontmostApplication() else {
        return (None, None);
    };
    let pid = app.processIdentifier();
    if pid <= 0 {
        return (None, None);
    }
    let Some((_, focused)) = focused_element_for_pid(pid) else {
        return (None, None);
    };
    let element = focused.as_CFTypeRef();
    // Read the selection once and share it: the anchor needs it for
    // AXBoundsForRange, the target for the prefix/suffix split.
    let selection_value = copy_attribute(element, "AXSelectedTextRange");
    let anchor = anchor_for(element, selection_value.as_ref().map(|v| v.as_CFTypeRef()));
    let target = if want_target {
        capture_target_from_element(element, pid, selection_value.as_ref())
    } else {
        None
    };
    (target, anchor)
}

/// Build the streaming target from an already-resolved focused element. Only a
/// settable text element with a valid in-range selection qualifies; anything
/// else returns None so the caller keeps the visual-only preview + final paste.
fn capture_target_from_element(
    element: AXUIElementRef,
    pid: i32,
    selection_value: Option<&CFType>,
) -> Option<Target> {
    let role = string_attribute(element, "AXRole").unwrap_or_default();
    let text_role = matches!(role.as_str(), "AXTextArea" | "AXTextField" | "AXComboBox");
    if !text_role
        || !is_settable(element, "AXValue")
        || !is_settable(element, "AXSelectedTextRange")
    {
        return None;
    }
    let value = string_attribute(element, "AXValue")?;
    if value.encode_utf16().count() > MAX_FIELD_UTF16 {
        return None;
    }
    let selection = ax_range(selection_value?.as_CFTypeRef())?;
    let utf16_len = value.encode_utf16().count();
    let start = selection.location as usize;
    let end = start.checked_add(selection.length as usize)?;
    if start > utf16_len || end > utf16_len {
        return None;
    }
    Some(Target {
        pid,
        role,
        identifier: string_attribute(element, "AXIdentifier"),
        element_frame: element_frame(element),
        value,
        selection,
    })
}

fn capture_anchor_on_main() -> Option<CaretAnchor> {
    // Right-Option agent path: the anchor only, no streaming target.
    capture_focused_on_main(false).1
}

fn run_on_main_thread<F, R>(work: F) -> R
where
    F: FnOnce() -> R,
    R: Default,
{
    if unsafe { pthread_main_np() } != 0 {
        return work();
    }
    struct Context<F, R> {
        work: Option<F>,
        result: Option<R>,
    }
    extern "C" fn trampoline<F, R>(ptr: *mut std::ffi::c_void)
    where
        F: FnOnce() -> R,
    {
        let context = unsafe { &mut *(ptr as *mut Context<F, R>) };
        if let Some(work) = context.work.take() {
            context.result = Some(work());
        }
    }
    let mut context = Context {
        work: Some(work),
        result: None,
    };
    unsafe {
        dispatch_sync_f(
            &_dispatch_main_q as *const _ as *mut _,
            &mut context as *mut Context<F, R> as *mut _,
            trampoline::<F, R>,
        );
    }
    context.result.unwrap_or_default()
}

fn frames_match(expected: Option<CGRect>, actual: Option<CGRect>) -> bool {
    match (expected, actual) {
        (Some(a), Some(b)) => {
            (a.origin.x - b.origin.x).abs() < 2.0
                && (a.origin.y - b.origin.y).abs() < 2.0
                && (a.size.width - b.size.width).abs() < 2.0
                && (a.size.height - b.size.height).abs() < 2.0
        }
        (None, None) => true,
        _ => false,
    }
}

fn target_matches(target: &Target, element: AXUIElementRef) -> bool {
    if string_attribute(element, "AXRole").as_deref() != Some(target.role.as_str()) {
        return false;
    }
    if let Some(expected) = target.identifier.as_deref() {
        return string_attribute(element, "AXIdentifier").as_deref() == Some(expected);
    }
    frames_match(target.element_frame, element_frame(element))
}

fn read_current(target: &Target, element: AXUIElementRef) -> Option<(String, CFRange)> {
    if !target_matches(target, element) {
        return None;
    }
    let value = string_attribute(element, "AXValue")?;
    let selection = copy_attribute(element, "AXSelectedTextRange")?;
    Some((value, ax_range(selection.as_CFTypeRef())?))
}

fn set_value_and_selection(element: AXUIElementRef, value: &str, selection: CFRange) -> bool {
    let new_value = CFString::new(value);
    let value_err = unsafe {
        AXUIElementSetAttributeValue(
            element,
            ax_name("AXValue").as_concrete_TypeRef(),
            new_value.as_CFTypeRef(),
        )
    };
    if value_err != AX_ERROR_SUCCESS {
        return false;
    }
    let range_value = unsafe {
        AXValueCreate(
            K_AX_VALUE_TYPE_CFRANGE,
            &selection as *const _ as *const std::ffi::c_void,
        )
    };
    if range_value.is_null() {
        return false;
    }
    let range_value = unsafe { CFType::wrap_under_create_rule(range_value) };
    unsafe {
        AXUIElementSetAttributeValue(
            element,
            ax_name("AXSelectedTextRange").as_concrete_TypeRef(),
            range_value.as_CFTypeRef(),
        ) == AX_ERROR_SUCCESS
    }
}

fn replacement(prefix: &[u16], text: &str, suffix: &[u16]) -> (String, CFRange) {
    let text_utf16: Vec<u16> = text.encode_utf16().collect();
    let mut value = Vec::with_capacity(prefix.len() + text_utf16.len() + suffix.len());
    value.extend_from_slice(prefix);
    value.extend_from_slice(&text_utf16);
    value.extend_from_slice(suffix);
    (
        String::from_utf16_lossy(&value),
        CFRange {
            location: (prefix.len() + text_utf16.len()) as isize,
            length: 0,
        },
    )
}

fn write_if_expected(
    target: &Target,
    expected_value: &str,
    expected_selection: CFRange,
    new_value: &str,
    new_selection: CFRange,
) -> bool {
    let target = target.clone();
    let expected_value = expected_value.to_string();
    let new_value = new_value.to_string();
    // AXUIElement calls are thread-safe. Keep this off the AppKit main queue:
    // callers hold the transaction lock while committing, and dispatching to
    // main here could deadlock against a main-thread cancel/finalize path.
    let Some((_, focused)) = focused_element_for_pid(target.pid) else {
        return false;
    };
    let element = focused.as_CFTypeRef();
    let Some((current_value, current_selection)) = read_current(&target, element) else {
        return false;
    };
    if current_value != expected_value || current_selection != expected_selection {
        return false;
    }
    if set_value_and_selection(element, &new_value, new_selection) {
        true
    } else {
        let _ = set_value_and_selection(element, &expected_value, expected_selection);
        false
    }
}

fn rollback(transaction: &Transaction) {
    if !transaction.inserted {
        return;
    }
    let Some(target) = transaction.target.as_ref() else {
        return;
    };
    let _ = write_if_expected(
        target,
        &transaction.expected_value,
        transaction.expected_selection,
        &transaction.original_value,
        transaction.original_selection,
    );
}

/// Capture the focused editable and its caret before any o8 surface is ordered
/// front. `stream_partials` is false for Smart Compose: it preserves the target
/// transaction without inserting the spoken instruction itself.
pub(crate) fn begin(stream_partials: bool) -> PartialsSurface {
    cancel_active();
    let surface = configured_surface();
    // One main-thread round-trip resolves the focused element and derives both
    // the caret anchor and (unless o8's own webview owns the field) the
    // streaming target — captured BEFORE any o8 surface is ordered front.
    let (target, anchor) = if surface == PartialsSurface::Caret {
        let want_target = !crate::paste::frontmost_is_o8();
        run_on_main_thread(move || capture_focused_on_main(want_target))
    } else {
        (None, None)
    };
    let (original_value, original_selection, prefix, suffix) = target
        .as_ref()
        .map(|target| {
            let utf16: Vec<u16> = target.value.encode_utf16().collect();
            let start = target.selection.location as usize;
            let end = start + target.selection.length as usize;
            (
                target.value.clone(),
                target.selection,
                utf16[..start].to_vec(),
                utf16[end..].to_vec(),
            )
        })
        .unwrap_or_else(|| (String::new(), CFRange::default(), Vec::new(), Vec::new()));
    let transaction = Transaction {
        session_id: None,
        surface,
        stream_partials,
        target,
        anchor,
        original_value: original_value.clone(),
        original_selection,
        prefix,
        suffix,
        expected_value: original_value,
        expected_selection: original_selection,
        inserted: false,
    };
    *TRANSACTION.lock().unwrap_or_else(|e| e.into_inner()) = Some(transaction);
    surface
}

pub(crate) fn bind_session(session_id: u64) {
    if let Some(transaction) = TRANSACTION
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_mut()
    {
        transaction.session_id = Some(session_id);
    }
}

pub(crate) fn current_anchor() -> Option<CaretAnchor> {
    TRANSACTION.lock().ok()?.as_ref()?.anchor
}

pub(crate) fn capture_caret_anchor() -> Option<CaretAnchor> {
    run_on_main_thread(capture_anchor_on_main)
}

fn apply_partial(session_id: u64, text: &str) {
    let mut guard = TRANSACTION.lock().unwrap_or_else(|e| e.into_inner());
    let Some(transaction) = guard.as_mut() else {
        return;
    };
    if transaction.session_id != Some(session_id)
        || transaction.surface != PartialsSurface::Caret
        || !transaction.stream_partials
        || text.is_empty()
    {
        return;
    }
    let Some(target) = transaction.target.as_ref() else {
        return;
    };
    let (new_value, new_selection) = replacement(&transaction.prefix, text, &transaction.suffix);
    if new_value == transaction.expected_value {
        return;
    }
    if write_if_expected(
        target,
        &transaction.expected_value,
        transaction.expected_selection,
        &new_value,
        new_selection,
    ) {
        transaction.expected_value = new_value;
        transaction.expected_selection = new_selection;
        transaction.inserted = true;
    }
}

/// Coalesce high-frequency recognizer partials into a single AX writer. The STT
/// router stays non-blocking, and slower Intel Macs process the latest text
/// instead of building an unbounded queue of stale intermediate revisions.
pub(crate) fn queue_partial(session_id: u64, text: String) {
    *LATEST_PARTIAL.lock().unwrap_or_else(|e| e.into_inner()) = Some((session_id, text));
    if UPDATE_WORKER_RUNNING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }
    std::thread::spawn(|| loop {
        let next = LATEST_PARTIAL
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        if let Some((session_id, text)) = next {
            apply_partial(session_id, &text);
            std::thread::sleep(std::time::Duration::from_millis(45));
            continue;
        }
        UPDATE_WORKER_RUNNING.store(false, Ordering::SeqCst);
        let pending = LATEST_PARTIAL
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some();
        if pending
            && UPDATE_WORKER_RUNNING
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
        {
            continue;
        }
        break;
    });
}

pub(crate) fn finish(session_id: u64, text: &str) -> FinishOutcome {
    let mut guard = TRANSACTION.lock().unwrap_or_else(|e| e.into_inner());
    let Some(transaction) = guard.as_ref() else {
        return FinishOutcome::NotHandled;
    };
    if transaction.session_id != Some(session_id) {
        return FinishOutcome::NotHandled;
    }
    let Some(target) = transaction.target.as_ref() else {
        *guard = None;
        return FinishOutcome::NotHandled;
    };
    let (new_value, new_selection) = replacement(&transaction.prefix, text, &transaction.suffix);
    let applied = write_if_expected(
        target,
        &transaction.expected_value,
        transaction.expected_selection,
        &new_value,
        new_selection,
    );
    *guard = None;
    if applied {
        FinishOutcome::Applied
    } else {
        FinishOutcome::Conflict(
            "The caret target changed while you were dictating, so o8 did not overwrite it. Use Command-Option-V to paste the saved final text."
                .to_string(),
        )
    }
}

pub(crate) fn cancel_session(session_id: u64) {
    let mut guard = TRANSACTION.lock().unwrap_or_else(|e| e.into_inner());
    if guard
        .as_ref()
        .and_then(|transaction| transaction.session_id)
        != Some(session_id)
    {
        return;
    }
    if let Some(transaction) = guard.as_ref() {
        rollback(transaction);
    }
    *guard = None;
}

pub(crate) fn cancel_active() {
    let mut guard = TRANSACTION.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(transaction) = guard.as_ref() {
        rollback(transaction);
    }
    *guard = None;
    *LATEST_PARTIAL.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replacement_uses_utf16_offsets() {
        let original: Vec<u16> = "A😀Z".encode_utf16().collect();
        let (value, selection) = replacement(&original[..1], "hello", &original[3..]);
        assert_eq!(value, "AhelloZ");
        assert_eq!(selection.location, 6);
        assert_eq!(selection.length, 0);
    }
}
