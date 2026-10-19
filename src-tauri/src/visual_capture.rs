//! A marked frame belongs to one explicit request in the main workspace.
//! Capture uses the existing ink window. It never starts an assistant or a voice session.

#[cfg(target_os = "macos")]
mod imp {
    use std::sync::Mutex;
    use tauri::{Emitter, Manager};

    #[derive(Default)]
    struct Owner {
        id: String,
        finishing: bool,
        generation: u64,
        ready: bool,
    }
    static OWNER: Mutex<Option<Owner>> = Mutex::new(None);

    fn valid_id(id: &str) -> bool {
        !id.is_empty()
            && id.len() <= 96
            && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
    }

    fn main_only(window: &tauri::WebviewWindow) -> Result<(), String> {
        if window.label() != "main" {
            return Err("Visual capture belongs to the main workspace.".into());
        }
        Ok(())
    }

    fn lock_owner() -> std::sync::MutexGuard<'static, Option<Owner>> {
        OWNER
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[tauri::command]
    pub async fn o8_visual_capture_begin(
        app: tauri::AppHandle,
        window: tauri::WebviewWindow,
        id: String,
    ) -> Result<(), String> {
        main_only(&window)?;
        if !valid_id(&id) {
            return Err("Invalid visual capture identity.".into());
        }
        if !crate::mac_perms::screen_capture_granted() {
            return Err("Allow Screen Recording for o8 in System Settings before capturing visual instructions.".into());
        }
        if crate::presentation::overlay_show_blocked() {
            return Err("Screen drawing is unavailable during quiet presentation mode.".into());
        }
        {
            let mut owner = lock_owner();
            if owner.is_some()
                || crate::spatial_ink_window::is_armed()
                || crate::stt_engine::active_session_id() != 0
            {
                return Err("Another capture or dictation owns the screen. Finish it before starting visual instructions.".into());
            }
            if app.get_webview_window("spatial-ink").is_none() {
                return Err("The drawing surface is unavailable.".into());
            }
            *owner = Some(Owner {
                id: id.clone(),
                finishing: false,
                generation: 0,
                ready: false,
            });
            let Some(generation) = crate::spatial_ink_window::arm_visual(&app, id.clone()) else {
                *owner = None;
                return Err("Another capture took the screen before this request started.".into());
            };
            owner.as_mut().unwrap().generation = generation;
            crate::spatial_ink_window::prime_capture(&app, generation);
        }
        let generation = lock_owner()
            .as_ref()
            .map(|value| value.generation)
            .ok_or("Visual capture was cancelled.")?;
        let ready = tauri::async_runtime::spawn_blocking(move || {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
            while std::time::Instant::now() < deadline {
                if crate::spatial_ink_window::capture_ready(generation) {
                    return true;
                }
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            false
        })
        .await
        .unwrap_or(false);
        {
            let mut owner = lock_owner();
            let current = owner
                .as_ref()
                .filter(|value| value.id == id)
                .ok_or("Visual capture was cancelled.")?;
            if !ready || current.generation != crate::spatial_ink_window::generation() {
                crate::spatial_ink_window::disarm_visual(&app, current.generation);
                *owner = None;
                return Err(
                    "The screen image was not captured. Keep the draft and try again.".into(),
                );
            }
            if let Err(error) =
                crate::spatial_ink_window::begin_visual_controls(&app, current.generation, &id)
            {
                crate::spatial_ink_window::disarm_visual(&app, current.generation);
                *owner = None;
                return Err(error);
            }
        }
        let correlation = id.clone();
        let acknowledged = tauri::async_runtime::spawn_blocking(move || {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
            while std::time::Instant::now() < deadline {
                let owner = lock_owner();
                match owner
                    .as_ref()
                    .filter(|value| value.id == correlation && value.generation == generation)
                {
                    Some(value) if value.ready => return true,
                    None => return false,
                    _ => {}
                }
                drop(owner);
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            false
        })
        .await
        .unwrap_or(false);
        if !acknowledged {
            o8_visual_capture_cancel(app, window, id)?;
            return Err("The drawing controls did not become ready. Try capture again.".into());
        }
        Ok(())
    }

    #[tauri::command]
    pub fn o8_visual_capture_ready(window: tauri::WebviewWindow, id: String) -> Result<(), String> {
        if window.label() != "spatial-ink" {
            return Err("Only the drawing surface can acknowledge readiness.".into());
        }
        if let Some(owner) = lock_owner().as_mut().filter(|value| value.id == id) {
            owner.ready = true;
        }
        Ok(())
    }

    #[tauri::command]
    pub async fn o8_visual_capture_finish(
        app: tauri::AppHandle,
        window: tauri::WebviewWindow,
        id: String,
    ) -> Result<serde_json::Value, String> {
        main_only(&window)?;
        let generation = {
            let mut owner = lock_owner();
            let current = owner
                .as_mut()
                .filter(|value| value.id == id && !value.finishing && value.ready)
                .ok_or("This visual capture is no longer active.")?;
            current.finishing = true;
            current.generation
        };
        // A deliberate system dictation may have replaced the overlay. Never read its pixels or disarm it.
        if crate::spatial_ink_window::generation() != generation {
            let mut owner = lock_owner();
            if owner.as_ref().is_some_and(|value| value.id == id) {
                *owner = None;
            }
            return Err("Dictation changed during visual capture. Keep the draft and capture this frame again.".into());
        }
        let _ = app.emit_to(
            "spatial-ink",
            "o8:visual-capture-finish",
            serde_json::json!({"id": id}),
        );
        let correlation = id.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            crate::spatial_ink_window::take_visual_frame(generation, &correlation)
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result);
        let mut owner = lock_owner();
        if !owner.as_ref().is_some_and(|value| value.id == id) {
            return Err(
                "The capture owner changed. Capture this frame again in its original chat.".into(),
            );
        }
        if crate::spatial_ink_window::disarm_visual(&app, generation) {
            *owner = None;
            return result;
        }
        *owner = None;
        Err("The capture owner changed. Capture this frame again in its original chat.".into())
    }

    #[tauri::command]
    pub fn o8_visual_capture_cancel(
        app: tauri::AppHandle,
        window: tauri::WebviewWindow,
        id: String,
    ) -> Result<(), String> {
        main_only(&window)?;
        let mut owner = lock_owner();
        if owner.as_ref().is_some_and(|value| value.id == id) {
            if let Some(current) = owner.as_ref() {
                crate::spatial_ink_window::disarm_visual(&app, current.generation);
            }
            *owner = None;
        }
        Ok(())
    }

    pub fn register_shortcut(app: &tauri::AppHandle) {
        use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
        let Ok(shortcut) = "CommandOrControl+Shift+Y".parse::<Shortcut>() else {
            return;
        };
        if let Err(error) = app
            .global_shortcut()
            .on_shortcut(shortcut, |app, _, event| {
                if event.state == ShortcutState::Pressed {
                    let _ = app.emit_to("main", "o8:visual-capture-toggle", ());
                }
            })
        {
            log::warn!("[visual-capture] shortcut unavailable: {error}");
        }
    }

    #[cfg(test)]
    mod tests {
        use super::valid_id;
        #[test]
        fn capture_ids_are_bounded_correlations() {
            assert!(valid_id("frame-123-abcd"));
            for invalid in ["", "../other", "frame\nnext"] {
                assert!(!valid_id(invalid));
            }
            assert!(!valid_id(&"x".repeat(97)));
        }
    }
}

#[cfg(target_os = "macos")]
pub use imp::*;
