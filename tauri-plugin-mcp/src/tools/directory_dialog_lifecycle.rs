//! Main-thread, process-local presentation epochs. AppKit may reuse an
//! NSOpenPanel object, so object addresses alone are not presentation identity.
use std::{
    cell::{Cell, RefCell},
    ffi::{CString, c_void},
};

type Id = *mut c_void;
type Sel = *mut c_void;
#[link(name = "objc", kind = "dylib")]
unsafe extern "C" {
    fn objc_getClass(name: *const u8) -> Id;
    fn objc_allocateClassPair(superclass: Id, name: *const i8, extra_bytes: usize) -> Id;
    fn objc_registerClassPair(class: Id);
    fn class_addMethod(
        class: Id,
        selector: Sel,
        implementation: unsafe extern "C" fn(Id, Sel, Id),
        types: *const u8,
    ) -> i8;
    fn sel_registerName(name: *const u8) -> Sel;
    fn objc_msgSend();
}
thread_local! {
    static WATCHED: Cell<Id> = const { Cell::new(std::ptr::null_mut()) };
    static EPOCH: Cell<u64> = const { Cell::new(0) };
    static OBSERVER: RefCell<Option<Observer>> = const { RefCell::new(None) };
}
unsafe extern "C" fn changed(_: Id, _: Sel, notification: Id) {
    // Do not borrow panel state: notifications can arrive synchronously inside
    // cancel:/ok:. Only the main window's own sheet presentations count.
    let window = unsafe { get(notification, b"object\0") };
    WATCHED.with(|watched| {
        if !window.is_null() && watched.get() == window {
            EPOCH.with(|epoch| epoch.set(epoch.get().wrapping_add(1)));
        }
    });
}

unsafe fn get(object: Id, selector: &[u8]) -> Id {
    let send: unsafe extern "C" fn(Id, Sel) -> Id =
        unsafe { std::mem::transmute(objc_msgSend as *const c_void) };
    unsafe { send(object, sel_registerName(selector.as_ptr())) }
}
struct Observer {
    center: Id,
    object: Id,
}
impl Drop for Observer {
    fn drop(&mut self) {
        unsafe {
            let send: unsafe extern "C" fn(Id, Sel, Id) =
                std::mem::transmute(objc_msgSend as *const c_void);
            send(
                self.center,
                sel_registerName(b"removeObserver:\0".as_ptr()),
                self.object,
            );
            get(self.object, b"release\0");
            get(self.center, b"release\0");
        }
    }
}

pub(super) fn epoch(window: Id) -> Result<u64, ()> {
    WATCHED.with(|watched| watched.set(window));
    OBSERVER.with(|observer| {
        if observer.borrow().is_none() {
            unsafe {
                let name = CString::new(format!(
                    "O8DirectorySheetObserver_{}",
                    uuid::Uuid::new_v4().simple()
                ))
                .map_err(|_| ())?;
                let class =
                    objc_allocateClassPair(objc_getClass(b"NSObject\0".as_ptr()), name.as_ptr(), 0);
                if class.is_null() {
                    return Err(());
                }
                let selector = sel_registerName(b"sheetChanged:\0".as_ptr());
                if class_addMethod(class, selector, changed, b"v@:@\0".as_ptr()) == 0 {
                    return Err(());
                }
                objc_registerClassPair(class);
                let object = get(get(class, b"alloc\0"), b"init\0");
                let center = get(
                    objc_getClass(b"NSNotificationCenter\0".as_ptr()),
                    b"defaultCenter\0",
                );
                if object.is_null() || center.is_null() {
                    return Err(());
                }
                get(center, b"retain\0");
                let make_string: unsafe extern "C" fn(Id, Sel, *const u8) -> Id =
                    std::mem::transmute(objc_msgSend as *const c_void);
                let add: unsafe extern "C" fn(Id, Sel, Id, Sel, Id, Id) =
                    std::mem::transmute(objc_msgSend as *const c_void);
                for notification in [
                    b"NSWindowWillBeginSheetNotification\0".as_slice(),
                    b"NSWindowDidEndSheetNotification\0".as_slice(),
                ] {
                    let name = make_string(
                        objc_getClass(b"NSString\0".as_ptr()),
                        sel_registerName(b"stringWithUTF8String:\0".as_ptr()),
                        notification.as_ptr(),
                    );
                    // Default center is process-local. Never distributed or
                    // workspace notifications, and never external app input.
                    add(
                        center,
                        sel_registerName(b"addObserver:selector:name:object:\0".as_ptr()),
                        object,
                        selector,
                        name,
                        std::ptr::null_mut(),
                    );
                }
                *observer.borrow_mut() = Some(Observer { center, object });
            }
        }
        Ok(EPOCH.with(Cell::get))
    })
}
