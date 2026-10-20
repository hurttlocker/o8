//! Admission at the existing browser/native microphone start boundaries.
use std::sync::Mutex;
use tauri::{Runtime, WebviewWindow};

pub(crate) const BUSY: &str = "Another voice input is active. Finish it before starting another microphone.";
#[derive(Default)]
struct Claims {
    browser: Option<String>,
    native: Option<u64>,
    pending_native: Option<u64>,
    navigating: Option<String>,
}
static CLAIMS: Mutex<Claims> = Mutex::new(Claims {
    browser: None,
    native: None,
    pending_native: None,
    navigating: None,
});
impl Claims {
    fn browser(&mut self, owner: &str) -> Result<(), String> {
        if self.native.is_some()
            || self.pending_native.is_some()
            || self.browser.as_deref().is_some_and(|value| value != owner)
        {
            return Err(BUSY.into());
        }
        self.browser = Some(owner.into());
        Ok(())
    }
    fn reserve_native(&mut self, session: u64) -> Result<(), String> {
        if self.browser.is_some() || self.pending_native.is_some() {
            return Err(BUSY.into());
        }
        self.pending_native = Some(session);
        Ok(())
    }
    fn activate_native(&mut self, session: u64) -> Result<(), String> {
        if self.pending_native != Some(session) {
            return Err("Voice input reservation expired.".into());
        }
        self.pending_native = None;
        // Native dictation retains its existing session-fenced takeover behavior.
        self.native = Some(session);
        Ok(())
    }
    fn release_browser(&mut self, owner: &str) {
        if self.browser.as_deref() == Some(owner) {
            self.browser = None;
        }
    }
    fn release_native(&mut self, session: u64) {
        if self.native == Some(session) {
            self.native = None;
        }
    }
    fn release_pending(&mut self, session: u64) {
        if self.pending_native == Some(session) {
            self.pending_native = None;
        }
    }
}
fn authorized<R: Runtime>(window: &WebviewWindow<R>, owner: &str) -> Result<(), String> {
    if window.label() != "main"
        || owner.is_empty()
        || owner.len() > 96
        || !owner
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err("Only the main voice surface can own microphone input.".into());
    }
    Ok(())
}
#[tauri::command]
pub fn voice_input_claim<R: Runtime>(
    window: WebviewWindow<R>,
    owner: String,
) -> Result<(), String> {
    authorized(&window, &owner)?;
    CLAIMS
        .lock()
        .map_err(|_| "Voice input ownership unavailable.")?
        .browser(&owner)
}
#[tauri::command]
pub fn voice_input_release<R: Runtime>(
    window: WebviewWindow<R>,
    owner: String,
) -> Result<(), String> {
    authorized(&window, &owner)?;
    CLAIMS
        .lock()
        .map_err(|_| "Voice input ownership unavailable.")?
        .release_browser(&owner);
    Ok(())
}
pub(crate) struct NativeInput {
    session: u64,
}
impl NativeInput {
    pub(crate) fn session(&self) -> u64 {
        self.session
    }
    pub(crate) fn activate(&self) -> Result<(), String> {
        CLAIMS
            .lock()
            .map_err(|_| "Voice input ownership unavailable.")?
            .activate_native(self.session)
    }
}
impl Drop for NativeInput {
    fn drop(&mut self) {
        if let Ok(mut claims) = CLAIMS.lock() {
            claims.release_pending(self.session);
        }
    }
}
pub(crate) fn reserve_native(session: u64) -> Result<NativeInput, String> {
    CLAIMS
        .lock()
        .map_err(|_| "Voice input ownership unavailable.")?
        .reserve_native(session)?;
    Ok(NativeInput { session })
}
pub(crate) fn release_native(session: u64) {
    if let Ok(mut claims) = CLAIMS.lock() {
        claims.release_native(session);
    }
}
pub(crate) fn navigation_started() {
    if let Ok(mut claims) = CLAIMS.lock() {
        claims.navigating = claims.browser.clone();
    }
}
pub(crate) fn navigation_finished() {
    if let Ok(mut claims) = CLAIMS.lock() {
        // The previous document's media is gone. Never clear a new document's claim.
        if let Some(owner) = claims.navigating.take() {
            claims.release_browser(&owner);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::test::{get_ipc_response, mock_builder, MockRuntime, INVOKE_KEY};
    use tauri::Manager;
    #[test]
    fn native_and_browser_refuse_each_other_in_both_start_orders() {
        let mut claims = Claims::default();
        claims.browser("live-one").unwrap();
        assert!(claims.reserve_native(4).is_err());
        claims.release_browser("live-one");
        claims.reserve_native(4).unwrap();
        assert!(claims.browser("live-two").is_err());
        claims.activate_native(4).unwrap();
        assert!(claims.browser("live-two").is_err());
        claims.release_native(4);
        claims.browser("live-two").unwrap();
    }
    #[test]
    fn old_cleanup_cannot_release_a_replacement_input() {
        let mut claims = Claims::default();
        claims.reserve_native(1).unwrap();
        claims.activate_native(1).unwrap();
        claims.reserve_native(2).unwrap();
        claims.release_native(1);
        assert!(claims.browser("live-one").is_err());
        claims.activate_native(2).unwrap();
        claims.release_pending(1);
        claims.release_native(1);
        assert!(claims.browser("live-one").is_err());
        claims.release_native(2);
        claims.browser("live-one").unwrap();
        claims.release_browser("old-token");
        assert!(claims.reserve_native(3).is_err());
    }
    #[test]
    fn commands_enforce_native_exclusion_window_ownership_and_stale_cleanup() {
        *CLAIMS.lock().unwrap() = Claims::default();
        let app = mock_builder()
            .invoke_handler(tauri::generate_handler![
                voice_input_claim,
                voice_input_release
            ])
            .build(crate::app_context())
            .unwrap();
        let main = app.get_webview_window("main").unwrap_or_else(|| {
            tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
                .build()
                .unwrap()
        });
        let other = app.get_webview_window("dictation-pill").unwrap_or_else(|| {
            tauri::WebviewWindowBuilder::new(&app, "dictation-pill", Default::default())
                .build()
                .unwrap()
        });
        let url = app
            .config()
            .build
            .dev_url
            .clone()
            .unwrap_or_else(|| "tauri://localhost".parse().unwrap());
        let invoke = |window: &WebviewWindow<MockRuntime>, command: &str, owner: &str| {
            get_ipc_response(
                window,
                tauri::webview::InvokeRequest {
                    cmd: command.into(),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: url.clone(),
                    body: tauri::ipc::InvokeBody::Json(serde_json::json!({"owner": owner})),
                    headers: Default::default(),
                    invoke_key: INVOKE_KEY.into(),
                },
            )
        };
        let first = invoke(&main, "voice_input_claim", "live-old");
        assert!(first.is_ok(), "{:?}", first.err());
        assert!(crate::stt_engine::start().is_err());
        assert!(invoke(&other, "voice_input_release", "live-old").is_err());
        assert!(crate::stt_engine::start_with_gate(None).is_err());
        navigation_started();
        assert!(invoke(&main, "voice_input_release", "live-old").is_ok());
        assert!(invoke(&main, "voice_input_claim", "live-new").is_ok());
        navigation_finished();
        assert!(reserve_native(1).is_err());
        assert!(invoke(&main, "voice_input_release", "live-old").is_ok());
        assert!(reserve_native(1).is_err());
        assert!(invoke(&main, "voice_input_release", "live-new").is_ok());
        let pending = reserve_native(1).unwrap();
        assert!(invoke(&main, "voice_input_claim", "live-third").is_err());
        pending.activate().unwrap();
        drop(pending);
        assert!(invoke(&main, "voice_input_claim", "live-third").is_err());
        release_native(1);
        assert!(invoke(&other, "voice_input_claim", "live-third").is_err());
        assert!(invoke(&main, "voice_input_claim", "live-third").is_ok());
        assert!(invoke(&main, "voice_input_release", "live-third").is_ok());
    }
}
