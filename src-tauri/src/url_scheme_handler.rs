use core_foundation::base::TCFType;
use core_foundation::string::{CFString, CFStringRef};

const O8_URL_SCHEME: &str = "o8";
const O8_BUNDLE_ID: &str = "ai.o8.desktop";

#[link(name = "CoreServices", kind = "framework")]
extern "C" {
    fn LSSetDefaultHandlerForURLScheme(
        in_url_scheme: CFStringRef,
        in_handler_bundle_id: CFStringRef,
    ) -> i32;
}

/// Reassert the installed app after LaunchServices has observed stale DMG or build copies.
pub fn reassert_o8_scheme_handler() {
    let scheme = CFString::new(O8_URL_SCHEME);
    let bundle_id = CFString::new(O8_BUNDLE_ID);
    let status = unsafe {
        LSSetDefaultHandlerForURLScheme(
            scheme.as_concrete_TypeRef(),
            bundle_id.as_concrete_TypeRef(),
        )
    };
    if status == 0 {
        log::info!("[url-scheme] reasserted {O8_BUNDLE_ID} as the {O8_URL_SCHEME} handler");
    } else {
        log::warn!(
            "[url-scheme] could not reassert {O8_BUNDLE_ID} as the {O8_URL_SCHEME} handler (OSStatus {status})"
        );
    }
}
