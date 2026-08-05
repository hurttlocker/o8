use std::ffi::c_void;
use std::sync::mpsc;
use std::time::Duration;

use log::debug;
use tauri::{Runtime, Webview};

use super::{InputResult, MouseButton, MouseParams, TextParams, TextResult};
use crate::error::Error;

// ---- Raw ObjC runtime FFI (replaces objc 0.2 / cocoa crates) ----

type Id = *mut c_void;
type Class = *mut c_void;
type Sel = *mut c_void;
const NIL: Id = std::ptr::null_mut();

#[repr(C)]
#[derive(Clone, Copy)]
struct NSPoint {
    x: f64,
    y: f64,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct NSSize {
    width: f64,
    height: f64,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct NSRect {
    origin: NSPoint,
    size: NSSize,
}

#[link(name = "objc", kind = "dylib")]
unsafe extern "C" {
    fn objc_getClass(name: *const u8) -> Class;
    fn sel_registerName(name: *const u8) -> Sel;
    fn objc_msgSend();
}

// On x86_64, struct returns > 16 bytes use a different entry point.
#[cfg(target_arch = "x86_64")]
#[link(name = "objc", kind = "dylib")]
unsafe extern "C" {
    fn objc_msgSend_stret();
}

// ---- Typed message-send trampolines ----
// Each transmutes objc_msgSend to the exact C calling convention needed.

// () return, 1 Id arg: [app sendEvent:event]
type MsgSendVoidId = unsafe extern "C" fn(Id, Sel, Id);
// Id return, no extra args: [cls alloc], [obj autorelease], [NSApp sharedApplication]
type MsgSendId = unsafe extern "C" fn(Id, Sel) -> Id;
// i64 return, no extra args: [window windowNumber]
type MsgSendI64 = unsafe extern "C" fn(Id, Sel) -> i64;
// Id return, 3 args: [NSString initWithBytes:length:encoding:]
type MsgSendInitStr = unsafe extern "C" fn(Id, Sel, *const c_void, usize, u64) -> Id;

// NSRect return — platform-specific entry point
// arm64: regular objc_msgSend returns structs in registers
// x86_64: structs > 16 bytes go through objc_msgSend_stret(out_ptr, self, _cmd, ...)
#[cfg(target_arch = "aarch64")]
type MsgSendRect = unsafe extern "C" fn(Id, Sel) -> NSRect;
#[cfg(target_arch = "aarch64")]
type MsgSendRectRect = unsafe extern "C" fn(Id, Sel, NSRect) -> NSRect;

#[cfg(target_arch = "x86_64")]
type MsgSendStretRect = unsafe extern "C" fn(*mut NSRect, Id, Sel);
#[cfg(target_arch = "x86_64")]
type MsgSendStretRectRect = unsafe extern "C" fn(*mut NSRect, Id, Sel, NSRect);

// mouseEventWithType:location:modifierFlags:timestamp:windowNumber:context:eventNumber:clickCount:pressure:
type MsgSendMouseEvent =
    unsafe extern "C" fn(Class, Sel, u64, NSPoint, u64, f64, i64, Id, i64, i64, f32) -> Id;

// keyEventWithType:location:modifierFlags:timestamp:windowNumber:context:characters:charactersIgnoringModifiers:isARepeat:keyCode:
type MsgSendKeyEvent =
    unsafe extern "C" fn(Class, Sel, u64, NSPoint, u64, f64, i64, Id, Id, Id, i8, u16) -> Id;

// ---- Helpers ----

unsafe fn class(name: &[u8]) -> Class {
    unsafe { objc_getClass(name.as_ptr()) }
}

unsafe fn sel(name: &[u8]) -> Sel {
    unsafe { sel_registerName(name.as_ptr()) }
}

/// Get an NSRect by sending a no-arg message (e.g. [window frame])
#[cfg(target_arch = "aarch64")]
unsafe fn msg_send_rect(obj: Id, sel: Sel) -> NSRect {
    unsafe {
        let f: MsgSendRect = std::mem::transmute(objc_msgSend as *const c_void);
        f(obj, sel)
    }
}

#[cfg(target_arch = "x86_64")]
unsafe fn msg_send_rect(obj: Id, sel: Sel) -> NSRect {
    unsafe {
        let mut result = std::mem::zeroed::<NSRect>();
        let f: MsgSendStretRect = std::mem::transmute(objc_msgSend_stret as *const c_void);
        f(&mut result, obj, sel);
        result
    }
}

/// Get an NSRect by sending a message with one NSRect arg (e.g. [window contentRectForFrameRect:])
#[cfg(target_arch = "aarch64")]
unsafe fn msg_send_rect_rect(obj: Id, sel: Sel, arg: NSRect) -> NSRect {
    unsafe {
        let f: MsgSendRectRect = std::mem::transmute(objc_msgSend as *const c_void);
        f(obj, sel, arg)
    }
}

#[cfg(target_arch = "x86_64")]
unsafe fn msg_send_rect_rect(obj: Id, sel: Sel, arg: NSRect) -> NSRect {
    unsafe {
        let mut result = std::mem::zeroed::<NSRect>();
        let f: MsgSendStretRectRect = std::mem::transmute(objc_msgSend_stret as *const c_void);
        f(&mut result, obj, sel, arg);
        result
    }
}

// ---- NSEventType constants ----

const NS_LEFT_MOUSE_DOWN: u64 = 1;
const NS_LEFT_MOUSE_UP: u64 = 2;
const NS_RIGHT_MOUSE_DOWN: u64 = 3;
const NS_RIGHT_MOUSE_UP: u64 = 4;
const NS_MOUSE_MOVED: u64 = 5;
const NS_KEY_DOWN: u64 = 10;
const NS_KEY_UP: u64 = 11;
const NS_OTHER_MOUSE_DOWN: u64 = 25;
const NS_OTHER_MOUSE_UP: u64 = 26;

/// Get the content rect height of an NSWindow for coordinate flipping.
unsafe fn get_content_height(ns_window: Id) -> f64 {
    unsafe {
        let frame = msg_send_rect(ns_window, sel(b"frame\0"));
        let content_rect = msg_send_rect_rect(ns_window, sel(b"contentRectForFrameRect:\0"), frame);
        content_rect.size.height
    }
}

/// Get the window number for an NSWindow.
unsafe fn get_window_number(ns_window: Id) -> i64 {
    unsafe {
        let f: MsgSendI64 = std::mem::transmute(objc_msgSend as *const c_void);
        f(ns_window, sel(b"windowNumber\0"))
    }
}

/// Create and send an NSEvent mouse event to [NSApp sendEvent:].
unsafe fn send_mouse_event(
    event_type: u64,
    location: NSPoint,
    window_number: i64,
    click_count: i64,
    pressure: f32,
) {
    unsafe {
        let send_id: MsgSendId = std::mem::transmute(objc_msgSend as *const c_void);
        let ns_app = send_id(class(b"NSApplication\0"), sel(b"sharedApplication\0"));

        let create: MsgSendMouseEvent = std::mem::transmute(objc_msgSend as *const c_void);
        let event = create(
            class(b"NSEvent\0"),
            sel(b"mouseEventWithType:location:modifierFlags:timestamp:windowNumber:context:eventNumber:clickCount:pressure:\0"),
            event_type, location, 0u64, 0.0f64, window_number, NIL, 0i64, click_count, pressure,
        );

        let send_event: MsgSendVoidId = std::mem::transmute(objc_msgSend as *const c_void);
        send_event(ns_app, sel(b"sendEvent:\0"), event);
    }
}

/// Create and send an NSEvent keyboard event to [NSApp sendEvent:].
unsafe fn send_key_event(
    event_type: u64,
    characters: Id, // NSString
    window_number: i64,
) {
    unsafe {
        let send_id: MsgSendId = std::mem::transmute(objc_msgSend as *const c_void);
        let ns_app = send_id(class(b"NSApplication\0"), sel(b"sharedApplication\0"));

        let create: MsgSendKeyEvent = std::mem::transmute(objc_msgSend as *const c_void);
        let event = create(
            class(b"NSEvent\0"),
            sel(b"keyEventWithType:location:modifierFlags:timestamp:windowNumber:context:characters:charactersIgnoringModifiers:isARepeat:keyCode:\0"),
            event_type,
            NSPoint { x: 0.0, y: 0.0 },
            0u64, 0.0f64, window_number, NIL,
            characters, characters,
            0i8, // isARepeat = NO
            0u16, // keyCode
        );

        let send_event: MsgSendVoidId = std::mem::transmute(objc_msgSend as *const c_void);
        send_event(ns_app, sel(b"sendEvent:\0"), event);
    }
}

/// Convert a Rust &str to an autoreleased NSString.
unsafe fn nsstring_from_str(s: &str) -> Id {
    unsafe {
        let send_id: MsgSendId = std::mem::transmute(objc_msgSend as *const c_void);
        let raw = send_id(class(b"NSString\0"), sel(b"alloc\0"));

        let init: MsgSendInitStr = std::mem::transmute(objc_msgSend as *const c_void);
        let ns_str = init(
            raw,
            sel(b"initWithBytes:length:encoding:\0"),
            s.as_ptr() as *const c_void,
            s.len(),
            4u64, // NSUTF8StringEncoding
        );

        send_id(ns_str, sel(b"autorelease\0"))
    }
}

// ---- Public API ----

/// Inject mouse events into the webview's NSWindow via with_webview.
pub fn inject_mouse<R: Runtime>(
    webview: &Webview<R>,
    params: &MouseParams,
) -> Result<InputResult, Error> {
    let x = params.x;
    let y = params.y;
    let click = params.click;
    let button = params.button;
    let mouse_down = params.mouse_down;
    let mouse_up = params.mouse_up;

    let (tx, rx) = mpsc::channel();

    webview
        .with_webview(move |platform_wv| {
            let result: Result<InputResult, String> = unsafe {
                let ns_window: Id = platform_wv.ns_window();
                if ns_window.is_null() {
                    return tx
                        .send(Err("NSWindow is nil".to_string()))
                        .unwrap_or(());
                }

                let content_height = get_content_height(ns_window);
                let window_number = get_window_number(ns_window);

                // CSS coords (top-left origin) -> NSWindow coords (bottom-left origin)
                let ns_point = NSPoint {
                    x: x as f64,
                    y: content_height - y as f64,
                };

                debug!(
                    "[NATIVE_INPUT] macOS mouse: css=({}, {}), ns_point=({}, {}), content_height={}",
                    x, y, ns_point.x, ns_point.y, content_height
                );

                // Send mouseMoved event
                send_mouse_event(NS_MOUSE_MOVED, ns_point, window_number, 0, 0.0);

                if click {
                    let (down_type, up_type) = match button {
                        MouseButton::Left => (NS_LEFT_MOUSE_DOWN, NS_LEFT_MOUSE_UP),
                        MouseButton::Right => (NS_RIGHT_MOUSE_DOWN, NS_RIGHT_MOUSE_UP),
                        MouseButton::Middle => (NS_OTHER_MOUSE_DOWN, NS_OTHER_MOUSE_UP),
                    };

                    send_mouse_event(down_type, ns_point, window_number, 1, 1.0);
                    send_mouse_event(up_type, ns_point, window_number, 1, 0.0);
                } else if mouse_down {
                    let down_type = match button {
                        MouseButton::Left => NS_LEFT_MOUSE_DOWN,
                        MouseButton::Right => NS_RIGHT_MOUSE_DOWN,
                        MouseButton::Middle => NS_OTHER_MOUSE_DOWN,
                    };
                    send_mouse_event(down_type, ns_point, window_number, 1, 1.0);
                } else if mouse_up {
                    let up_type = match button {
                        MouseButton::Left => NS_LEFT_MOUSE_UP,
                        MouseButton::Right => NS_RIGHT_MOUSE_UP,
                        MouseButton::Middle => NS_OTHER_MOUSE_UP,
                    };
                    send_mouse_event(up_type, ns_point, window_number, 1, 0.0);
                }

                Ok(InputResult {
                    success: true,
                    position: (x, y),
                    error: None,
                })
            };

            tx.send(result).unwrap_or(());
        })
        .map_err(|e| Error::Anyhow(format!("with_webview failed: {}", e)))?;

    let result = rx
        .recv_timeout(Duration::from_secs(5))
        .map_err(|e| Error::Anyhow(format!("with_webview timed out: {}", e)))?
        .map_err(|e| Error::Anyhow(e))?;

    Ok(result)
}

/// Inject text as keyboard events into the webview's NSWindow via with_webview.
/// For delay_ms > 0, injects characters one at a time.
pub fn inject_text<R: Runtime>(
    webview: &Webview<R>,
    params: &TextParams,
) -> Result<TextResult, Error> {
    let text = params.text.clone();
    let chars: Vec<char> = text.chars().collect();
    let total_chars = chars.len() as u32;

    if params.delay_ms == 0 {
        // Fast path: inject entire string at once
        let (tx, rx) = mpsc::channel();

        webview
            .with_webview(move |platform_wv| {
                let result: Result<(), String> = unsafe {
                    let ns_window: Id = platform_wv.ns_window();
                    if ns_window.is_null() {
                        return tx.send(Err("NSWindow is nil".to_string())).unwrap_or(());
                    }

                    let window_number = get_window_number(ns_window);
                    let ns_str = nsstring_from_str(&text);

                    send_key_event(NS_KEY_DOWN, ns_str, window_number);
                    send_key_event(NS_KEY_UP, ns_str, window_number);

                    Ok(())
                };

                tx.send(result).unwrap_or(());
            })
            .map_err(|e| Error::Anyhow(format!("with_webview failed: {}", e)))?;

        rx.recv_timeout(Duration::from_secs(5))
            .map_err(|e| Error::Anyhow(format!("with_webview timed out: {}", e)))?
            .map_err(|e| Error::Anyhow(e))?;
    } else {
        // Slow path: character by character with delays
        for ch in &chars {
            let ch_string = ch.to_string();
            let (tx, rx) = mpsc::channel();

            webview
                .with_webview(move |platform_wv| {
                    let result: Result<(), String> = unsafe {
                        let ns_window: Id = platform_wv.ns_window();
                        if ns_window.is_null() {
                            return tx.send(Err("NSWindow is nil".to_string())).unwrap_or(());
                        }

                        let window_number = get_window_number(ns_window);
                        let ns_str = nsstring_from_str(&ch_string);

                        send_key_event(NS_KEY_DOWN, ns_str, window_number);
                        send_key_event(NS_KEY_UP, ns_str, window_number);

                        Ok(())
                    };

                    tx.send(result).unwrap_or(());
                })
                .map_err(|e| Error::Anyhow(format!("with_webview failed: {}", e)))?;

            rx.recv_timeout(Duration::from_secs(5))
                .map_err(|e| Error::Anyhow(format!("with_webview timed out: {}", e)))?
                .map_err(|e| Error::Anyhow(e))?;

            std::thread::sleep(Duration::from_millis(params.delay_ms));
        }
    }

    Ok(TextResult {
        success: true,
        chars_typed: total_chars,
        error: None,
    })
}
