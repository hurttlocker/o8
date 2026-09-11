//! Attached-keyboard detection for the external-keyboard Fn substitute (#2158).
//!
//! The "External keyboard Fn" dictation setting makes bottom-left Control mirror
//! Fn, for Windows-layout boards whose printed Fn key never leaves firmware (see
//! the `EXTERNAL_LEFT_CONTROL_FN` notes in `fn_hotkey.rs`). As a bare global
//! toggle it outlived the board it was enabled for: after a swap to an Apple
//! keyboard, Control kept opening the microphone until the operator went back
//! into Settings and found the switch.
//!
//! This module scopes the remap to the hardware it was meant for. The pref now
//! reads "remap Control while a non-Apple external keyboard is attached": the
//! tap's `EXTERNAL_LEFT_CONTROL_FN` atomic carries the EFFECTIVE value (pref AND
//! such a board present) and a watcher thread re-evaluates every
//! `POLL_INTERVAL`, so unplugging the board disarms Control and re-attaching it
//! re-arms — without touching Settings.
//!
//! **Detection heuristic** (`is_external_non_apple`): a HID device matching
//! Generic Desktop (usage page 0x01) / Keyboard (usage 0x06) counts as an
//! external non-Apple keyboard when all four hold —
//!
//!   1. IOKit does not report it as built-in (`Built-In`), and
//!   2. its transport is a real bus — `SPI` / `FIFO` are the internal board and
//!      `Virtual` is a software-synthesized keyboard (remapper drivers publish
//!      one, and remapping a remapper's phantom board is never what was meant),
//!   3. its USB vendor id is non-zero (zero means the device published no
//!      vendor, which is what virtual/aggregate nodes do), and
//!   4. that vendor id is neither of Apple's (0x05AC, and the 0x004C some Apple
//!      Bluetooth boards report). Apple keyboards carry a real Fn key, so they
//!      never want the substitute — that is exactly the swap this closes.
//!
//! **Permissions**: enumeration reads IORegistry metadata through `IOHIDManager`
//! WITHOUT calling `IOHIDManagerOpen`, which is the call that would need an
//! Input Monitoring grant to receive events. It therefore adds no TCC
//! requirement beyond the Accessibility + Input Monitoring pair the CGEventTap
//! already holds (`mac_perms.rs`), and no new entitlement.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

/// Apple's USB vendor id. Apple boards keep a real Fn key.
pub const APPLE_VENDOR_ID: u32 = 0x05AC;
/// The alternate vendor id some Apple Bluetooth keyboards report.
pub const APPLE_VENDOR_ID_ALT: u32 = 0x004C;

/// How often the watcher re-reads the attached keyboards. Only fires the IOKit
/// enumeration while the pref is ON, so the default (off) costs one atomic load
/// per tick.
const POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(2);

/// One attached HID keyboard, reduced to the fields the gating decision reads.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct HidKeyboard {
    pub vendor_id: u32,
    pub product_id: u32,
    /// IOKit `Product` — the name shown in Settings when the remap is live.
    pub product: Option<String>,
    /// IOKit `Transport` — `USB`, `Bluetooth`, `SPI`, `FIFO`, `Virtual`, …
    pub transport: Option<String>,
    /// IOKit `Built-In`.
    pub built_in: bool,
}

/// The gating outcome: whether Control currently mirrors Fn, and on which board.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RemapDecision {
    pub active: bool,
    pub keyboard: Option<String>,
}

/// What Settings renders: the stored pref plus the live effect of it.
#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Serialize)]
pub struct ExternalKeyboardFnState {
    /// The persisted `external_symon_left_control` pref.
    pub enabled: bool,
    /// Whether the Control-as-Fn remap is actually armed right now.
    pub active: bool,
    /// Product name of the board arming it, when active.
    pub keyboard: Option<String>,
}

/// Does this attached keyboard want the Control-as-Fn substitute? See the module
/// header for why each clause is here.
pub fn is_external_non_apple(kb: &HidKeyboard) -> bool {
    if kb.built_in || kb.vendor_id == 0 {
        return false;
    }
    if kb.vendor_id == APPLE_VENDOR_ID || kb.vendor_id == APPLE_VENDOR_ID_ALT {
        return false;
    }
    match kb.transport.as_deref().map(str::trim) {
        Some(t) if t.eq_ignore_ascii_case("virtual") => false,
        Some(t) if t.eq_ignore_ascii_case("spi") => false,
        Some(t) if t.eq_ignore_ascii_case("fifo") => false,
        _ => true,
    }
}

/// The whole gating decision, pure: pref state + attached devices in, remap
/// state + display name out. The IOKit call sits behind `enumerate_keyboards`
/// so this stays testable without hardware.
pub fn decide_remap(pref_enabled: bool, devices: &[HidKeyboard]) -> RemapDecision {
    if !pref_enabled {
        return RemapDecision::default();
    }
    match devices.iter().find(|kb| is_external_non_apple(kb)) {
        Some(kb) => RemapDecision {
            active: true,
            keyboard: Some(display_name(kb)),
        },
        None => RemapDecision::default(),
    }
}

/// Product name when the board publishes one, else a `vendor:product` fallback
/// so Settings never shows an empty "Active:" line.
fn display_name(kb: &HidKeyboard) -> String {
    kb.product
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(|name| name.to_string())
        .unwrap_or_else(|| format!("External keyboard {:04x}:{:04x}", kb.vendor_id, kb.product_id))
}

// ── Live state ──

/// The persisted pref (`external_symon_left_control`).
static PREF_ENABLED: AtomicBool = AtomicBool::new(false);
/// The effective state — pref AND a qualifying board attached.
static REMAP_ACTIVE: AtomicBool = AtomicBool::new(false);
static ACTIVE_KEYBOARD: Mutex<Option<String>> = Mutex::new(None);
static WATCHER_STARTED: AtomicBool = AtomicBool::new(false);

/// Store the pref and re-evaluate immediately, so Settings applies live (the
/// old direct `fn_hotkey::set_external_left_control_fn` write path).
pub fn set_pref_enabled(enabled: bool) {
    PREF_ENABLED.store(enabled, Ordering::SeqCst);
    reevaluate();
}

/// Snapshot for the Settings surface.
pub fn state() -> ExternalKeyboardFnState {
    ExternalKeyboardFnState {
        enabled: PREF_ENABLED.load(Ordering::SeqCst),
        active: REMAP_ACTIVE.load(Ordering::SeqCst),
        keyboard: ACTIVE_KEYBOARD.lock().ok().and_then(|k| k.clone()),
    }
}

/// Re-read the attached keyboards and push the effective value into the event
/// tap. Skips the IOKit enumeration entirely when the pref is off.
pub fn reevaluate() {
    let pref = PREF_ENABLED.load(Ordering::SeqCst);
    let decision = if pref {
        decide_remap(true, &enumerate_keyboards())
    } else {
        RemapDecision::default()
    };
    apply(decision);
}

fn apply(decision: RemapDecision) {
    let was_active = REMAP_ACTIVE.swap(decision.active, Ordering::SeqCst);
    let previous = ACTIVE_KEYBOARD
        .lock()
        .map(|mut slot| std::mem::replace(&mut *slot, decision.keyboard.clone()))
        .unwrap_or(None);
    crate::fn_hotkey::set_external_left_control_fn(decision.active);
    if was_active != decision.active || previous != decision.keyboard {
        match (decision.active, decision.keyboard.as_deref()) {
            (true, Some(name)) => tracing::info!(
                "[external-keyboard] Control-as-Fn armed for attached keyboard: {name}"
            ),
            (true, None) => tracing::info!("[external-keyboard] Control-as-Fn armed"),
            (false, _) if PREF_ENABLED.load(Ordering::SeqCst) => tracing::info!(
                "[external-keyboard] Control-as-Fn idle — no external non-Apple keyboard attached"
            ),
            (false, _) => tracing::info!("[external-keyboard] Control-as-Fn disabled"),
        }
    }
}

/// Start the device watcher. Idempotent; call once alongside the event tap.
///
/// A poll rather than `IOHIDManager` matching callbacks on purpose: the callback
/// form has to be scheduled on a CFRunLoop, and the only run loop in this path
/// belongs to the CGEventTap thread — whose callback macOS disables if it ever
/// runs slowly. A 2s poll on its own thread keeps the tap thread untouched, and
/// costs a single atomic load per tick while the pref is off.
pub fn start_watcher() {
    if WATCHER_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::Builder::new()
        .name("o8-external-keyboard".into())
        .spawn(|| loop {
            reevaluate();
            std::thread::sleep(POLL_INTERVAL);
        })
        .map(|_| ())
        .unwrap_or_else(|e| {
            WATCHER_STARTED.store(false, Ordering::SeqCst);
            tracing::warn!("[external-keyboard] watcher thread failed to spawn: {e}");
        });
}

// ── IOKit enumeration (macOS) ──

mod ffi {
    use core_foundation::base::{CFAllocatorRef, CFTypeRef};
    use core_foundation::dictionary::CFDictionaryRef;
    use core_foundation::set::CFSetRef;
    use core_foundation::string::CFStringRef;
    use std::ffi::c_void;

    pub type IOHIDManagerRef = *mut c_void;
    pub type IOHIDDeviceRef = *mut c_void;

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        pub fn IOHIDManagerCreate(allocator: CFAllocatorRef, options: u32) -> IOHIDManagerRef;
        pub fn IOHIDManagerSetDeviceMatching(manager: IOHIDManagerRef, matching: CFDictionaryRef);
        pub fn IOHIDManagerCopyDevices(manager: IOHIDManagerRef) -> CFSetRef;
        pub fn IOHIDDeviceGetProperty(device: IOHIDDeviceRef, key: CFStringRef) -> CFTypeRef;
    }
}

/// Every attached HID keyboard, as IOKit reports it. Empty on any failure —
/// a failed read must read as "no external board", never as "remap everything".
pub fn enumerate_keyboards() -> Vec<HidKeyboard> {
    use core_foundation::base::{kCFAllocatorDefault, CFRelease, CFTypeRef, TCFType};
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::number::CFNumber;
    use core_foundation::set::{CFSetGetCount, CFSetGetValues};
    use core_foundation::string::CFString;
    use std::ffi::c_void;

    // HID usage page 0x01 (Generic Desktop) / usage 0x06 (Keyboard).
    const GENERIC_DESKTOP_USAGE_PAGE: i32 = 0x01;
    const KEYBOARD_USAGE: i32 = 0x06;

    unsafe {
        let manager = ffi::IOHIDManagerCreate(kCFAllocatorDefault, 0);
        if manager.is_null() {
            return Vec::new();
        }
        let matching = CFDictionary::from_CFType_pairs(&[
            (
                CFString::new("DeviceUsagePage").as_CFType(),
                CFNumber::from(GENERIC_DESKTOP_USAGE_PAGE).as_CFType(),
            ),
            (
                CFString::new("DeviceUsage").as_CFType(),
                CFNumber::from(KEYBOARD_USAGE).as_CFType(),
            ),
        ]);
        ffi::IOHIDManagerSetDeviceMatching(manager, matching.as_concrete_TypeRef());

        let devices = ffi::IOHIDManagerCopyDevices(manager);
        if devices.is_null() {
            CFRelease(manager as CFTypeRef);
            return Vec::new();
        }
        let count = CFSetGetCount(devices).max(0) as usize;
        let mut refs: Vec<*const c_void> = vec![std::ptr::null(); count];
        if count > 0 {
            CFSetGetValues(devices, refs.as_mut_ptr());
        }
        let keyboards = refs
            .into_iter()
            .filter(|entry| !entry.is_null())
            .map(|entry| read_device(entry as ffi::IOHIDDeviceRef))
            .collect();

        CFRelease(devices as CFTypeRef);
        CFRelease(manager as CFTypeRef);
        keyboards
    }
}

unsafe fn read_device(device: ffi::IOHIDDeviceRef) -> HidKeyboard {
    HidKeyboard {
        vendor_id: number_prop(device, "VendorID").unwrap_or(0).max(0) as u32,
        product_id: number_prop(device, "ProductID").unwrap_or(0).max(0) as u32,
        product: string_prop(device, "Product"),
        transport: string_prop(device, "Transport"),
        built_in: bool_prop(device, "Built-In").unwrap_or(false),
    }
}

/// `IOHIDDeviceGetProperty` follows the Get Rule — the returned ref is NOT ours
/// to release, hence `wrap_under_get_rule` on every branch below.
unsafe fn raw_prop(
    device: ffi::IOHIDDeviceRef,
    key: &str,
) -> Option<core_foundation::base::CFTypeRef> {
    use core_foundation::base::TCFType;
    use core_foundation::string::CFString;

    let cf_key = CFString::new(key);
    let value = ffi::IOHIDDeviceGetProperty(device, cf_key.as_concrete_TypeRef());
    if value.is_null() {
        None
    } else {
        Some(value)
    }
}

unsafe fn number_prop(device: ffi::IOHIDDeviceRef, key: &str) -> Option<i64> {
    use core_foundation::base::{CFGetTypeID, TCFType};
    use core_foundation::number::{CFNumber, CFNumberRef};

    let value = raw_prop(device, key)?;
    if CFGetTypeID(value) != CFNumber::type_id() {
        return None;
    }
    CFNumber::wrap_under_get_rule(value as CFNumberRef).to_i64()
}

unsafe fn string_prop(device: ffi::IOHIDDeviceRef, key: &str) -> Option<String> {
    use core_foundation::base::{CFGetTypeID, TCFType};
    use core_foundation::string::{CFString, CFStringRef};

    let value = raw_prop(device, key)?;
    if CFGetTypeID(value) != CFString::type_id() {
        return None;
    }
    Some(CFString::wrap_under_get_rule(value as CFStringRef).to_string())
}

unsafe fn bool_prop(device: ffi::IOHIDDeviceRef, key: &str) -> Option<bool> {
    use core_foundation::base::{CFGetTypeID, TCFType};
    use core_foundation::boolean::{CFBoolean, CFBooleanRef};

    let value = raw_prop(device, key)?;
    if CFGetTypeID(value) != CFBoolean::type_id() {
        return None;
    }
    Some(bool::from(CFBoolean::wrap_under_get_rule(
        value as CFBooleanRef,
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn windows_layout_board() -> HidKeyboard {
        HidKeyboard {
            vendor_id: 0x1E7D,
            product_id: 0x311A,
            product: Some("Gaming Keyboard".to_string()),
            transport: Some("USB".to_string()),
            built_in: false,
        }
    }

    fn builtin_apple_board() -> HidKeyboard {
        HidKeyboard {
            vendor_id: APPLE_VENDOR_ID,
            product_id: 0x0342,
            product: Some("Apple Internal Keyboard / Trackpad".to_string()),
            transport: Some("SPI".to_string()),
            built_in: true,
        }
    }

    fn external_apple_board() -> HidKeyboard {
        HidKeyboard {
            vendor_id: APPLE_VENDOR_ID,
            product_id: 0x029C,
            product: Some("Magic Keyboard".to_string()),
            transport: Some("Bluetooth".to_string()),
            built_in: false,
        }
    }

    #[test]
    fn pref_off_never_arms_even_with_the_board_attached() {
        let decision = decide_remap(false, &[windows_layout_board()]);
        assert_eq!(decision, RemapDecision::default());
    }

    #[test]
    fn pref_on_arms_for_an_external_non_apple_board() {
        let decision = decide_remap(true, &[builtin_apple_board(), windows_layout_board()]);
        assert!(decision.active);
        assert_eq!(decision.keyboard.as_deref(), Some("Gaming Keyboard"));
    }

    #[test]
    fn unplugging_the_board_disarms_without_touching_the_pref() {
        // The #2158 swap: same pref, board gone, only the Apple boards left.
        let attached = vec![builtin_apple_board(), external_apple_board()];
        let decision = decide_remap(true, &attached);
        assert!(!decision.active);
        assert_eq!(decision.keyboard, None);
    }

    #[test]
    fn builtin_keyboard_alone_never_arms() {
        assert!(!decide_remap(true, &[builtin_apple_board()]).active);
    }

    #[test]
    fn apple_alternate_vendor_id_is_still_apple() {
        let mut board = external_apple_board();
        board.vendor_id = APPLE_VENDOR_ID_ALT;
        assert!(!is_external_non_apple(&board));
    }

    #[test]
    fn virtual_and_vendorless_devices_are_ignored() {
        let remapper_phantom = HidKeyboard {
            vendor_id: 0x16C0,
            product_id: 0x27DB,
            product: Some("Virtual HID Keyboard".to_string()),
            transport: Some("Virtual".to_string()),
            built_in: false,
        };
        let vendorless = HidKeyboard {
            vendor_id: 0,
            product_id: 0,
            product: None,
            transport: Some("USB".to_string()),
            built_in: false,
        };
        assert!(!is_external_non_apple(&remapper_phantom));
        assert!(!is_external_non_apple(&vendorless));
        assert!(!decide_remap(true, &[remapper_phantom, vendorless]).active);
    }

    #[test]
    fn nameless_board_falls_back_to_vendor_and_product_ids() {
        let mut board = windows_layout_board();
        board.product = Some("   ".to_string());
        let decision = decide_remap(true, &[board]);
        assert!(decision.active);
        assert_eq!(
            decision.keyboard.as_deref(),
            Some("External keyboard 1e7d:311a")
        );
    }

    #[test]
    fn empty_device_list_reads_as_no_external_board() {
        assert!(!decide_remap(true, &[]).active);
    }

    /// Manual probe against the real machine's attached keyboards — proves the
    /// IOKit path enumerates without `IOHIDManagerOpen`. Ignored by default
    /// because it asserts on hardware:
    /// `cargo test --lib -- --ignored --nocapture attached_keyboards`
    #[test]
    #[ignore]
    fn attached_keyboards_probe() {
        let devices = enumerate_keyboards();
        for kb in &devices {
            println!(
                "vendor={:04x} product={:04x} built_in={} transport={:?} name={:?} external={}",
                kb.vendor_id,
                kb.product_id,
                kb.built_in,
                kb.transport,
                kb.product,
                is_external_non_apple(kb)
            );
        }
        assert!(!devices.is_empty(), "expected at least one attached keyboard");
    }
}
