//! One continuous visual capture belongs to one request in the main workspace.
use crate::visual_capture_session::{Session, Shared, Widget};
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{Emitter, Manager};

struct Owner {
    id: String,
    generation: u64,
    ready: bool,
    finishing: bool,
    session: Option<Session>,
    shared: Option<Arc<Shared>>,
    directory: PathBuf,
    cancelled: Arc<AtomicBool>,
    transcribing: bool,
}
static OWNER: Mutex<Option<Owner>> = Mutex::new(None);
fn lock_owner() -> std::sync::MutexGuard<'static, Option<Owner>> {
    OWNER.lock().unwrap_or_else(|value| value.into_inner())
}
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 96 && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
}
fn create_private_directory(directory: &std::path::Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(directory.parent().ok_or("Invalid capture storage.")?)
        .map_err(|_| "Could not create capture storage.")?;
    std::fs::create_dir(directory)
        .map_err(|_| "This capture identity already exists. Start a new capture.")?;
    if std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700)).is_err() {
        let _ = std::fs::remove_dir(directory);
        return Err("Could not protect the capture.".into());
    }
    Ok(())
}
fn take_owner(id: &str, generation: Option<u64>) -> Option<Owner> {
    let mut owner = lock_owner();
    if owner.as_ref().is_some_and(|value| {
        value.id == id && generation.is_none_or(|expected| value.generation == expected)
    }) {
        owner.take()
    } else {
        None
    }
}
fn main_only(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Visual capture belongs to the main workspace.".into());
    }
    Ok(())
}
fn overlay_only(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "spatial-ink" {
        return Err("Only the drawing surface can update visual controls.".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn o8_visual_capture_begin(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    id: String,
) -> Result<serde_json::Value, String> {
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
    let monitor = crate::spatial_ink_window::cursor_monitor(&app)
        .ok_or("No display is available for visual capture.")?;
    let directory = crate::agent::agent_data_dir()
        .join("visual-captures")
        .join(format!("{id}-{}", uuid::Uuid::new_v4()));
    let (generation, cancelled) = {
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
        create_private_directory(&directory)?;
        let Some(generation) =
            crate::spatial_ink_window::arm_visual(&app, id.clone(), monitor.clone())
        else {
            let _ = std::fs::remove_dir(&directory);
            return Err("Another capture owns the screen.".into());
        };
        let cancelled = Arc::new(AtomicBool::new(false));
        *owner = Some(Owner {
            id: id.clone(),
            generation,
            ready: false,
            finishing: false,
            session: None,
            shared: None,
            directory: directory.clone(),
            cancelled: cancelled.clone(),
            transcribing: false,
        });
        (generation, cancelled)
    };
    crate::spatial_ink_window::set_visual_interaction(&app, generation, false);
    let app_clone = app.clone();
    let correlation = id.clone();
    let session = tauri::async_runtime::spawn_blocking(move || {
        Session::start(
            app_clone,
            correlation,
            generation,
            directory,
            monitor,
            cancelled,
        )
    })
    .await
    .map_err(|_| "Screen capture stopped unexpectedly.".to_string())
    .and_then(|result| result);
    let result: Result<(), String> = (|| {
        let session = session?;
        let mut owner = lock_owner();
        let current = owner
            .as_mut()
            .filter(|value| value.id == id && value.generation == generation)
            .ok_or("Visual capture was cancelled.")?;
        if crate::spatial_ink_window::generation() != generation {
            return Err("Another dictation replaced visual capture.".into());
        }
        current.shared = Some(session.shared.clone());
        session.announce(&app, &id, generation)?;
        current.session = Some(session);
        Ok(())
    })();
    if let Err(error) = result {
        cancel_owned(app, id, Some(generation), true).await?;
        return Err(error);
    }
    let correlation = id.clone();
    let acknowledged = tauri::async_runtime::spawn_blocking(move || {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while std::time::Instant::now() < deadline {
            match lock_owner()
                .as_ref()
                .filter(|value| value.id == correlation && value.generation == generation)
            {
                Some(value) if value.ready => return true,
                None => return false,
                _ => {}
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        false
    })
    .await
    .unwrap_or(false);
    if !acknowledged {
        cancel_owned(app, id, Some(generation), true).await?;
        return Err("The drawing controls did not become ready. Try capture again.".into());
    }
    let owner = lock_owner();
    let current = owner
        .as_ref()
        .filter(|value| value.id == id && value.generation == generation)
        .ok_or("Visual capture was cancelled.")?;
    let elapsed = current
        .shared
        .as_ref()
        .ok_or("The screen recorder is unavailable.")?
        .started
        .elapsed()
        .as_millis();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "The capture clock is unavailable.")?
        .as_millis();
    Ok(serde_json::json!({"startedAtMs": now.saturating_sub(elapsed), "generation": generation}))
}

#[tauri::command]
pub fn o8_visual_capture_ready(
    window: tauri::WebviewWindow,
    id: String,
    generation: u64,
) -> Result<(), String> {
    overlay_only(&window)?;
    if let Some(owner) = lock_owner().as_mut().filter(|value| {
        value.id == id
            && !value.finishing
            && value.generation == generation
            && generation == crate::spatial_ink_window::generation()
    }) {
        owner.ready = true;
    }
    Ok(())
}

#[tauri::command]
pub fn o8_visual_capture_widget(
    window: tauri::WebviewWindow,
    id: String,
    generation: u64,
    widget: Widget,
) -> Result<(), String> {
    overlay_only(&window)?;
    if widget.regions.len() > 2
        || widget.regions.iter().any(|rect| {
            !rect.left.is_finite()
                || !rect.top.is_finite()
                || !rect.width.is_finite()
                || !rect.height.is_finite()
                || rect.left < 0.0
                || rect.top < 0.0
                || !(0.0..=460.0).contains(&rect.width)
                || !(0.0..=160.0).contains(&rect.height)
        })
    {
        return Err("Invalid capture control bounds.".into());
    }
    let owner = lock_owner();
    let current = owner
        .as_ref()
        .filter(|value| {
            value.id == id
                && !value.finishing
                && value.generation == generation
                && generation == crate::spatial_ink_window::generation()
        })
        .ok_or("This visual capture is no longer active.")?;
    let shared = current
        .shared
        .as_ref()
        .ok_or("Visual input is not ready.")?;
    if widget.regions.iter().any(|rect| {
        rect.left + rect.width > shared.bounds[2] + 1.0
            || rect.top + rect.height > shared.bounds[3] + 1.0
    }) {
        return Err("Capture controls must stay on the captured display.".into());
    }
    let typing = widget.typing;
    *shared
        .widget
        .lock()
        .unwrap_or_else(|value| value.into_inner()) = Some(widget);
    // Explicitly clicking the local input can take focus; drawing and narration never do.
    if typing {
        window
            .set_focus()
            .map_err(|_| "Click the instruction to type.")?;
    }
    Ok(())
}

#[tauri::command]
pub fn o8_visual_capture_undo(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    id: String,
    generation: u64,
) -> Result<(), String> {
    overlay_only(&window)?;
    let owner = lock_owner();
    let current = owner
        .as_ref()
        .filter(|value| {
            value.id == id
                && !value.finishing
                && value.generation == generation
                && generation == crate::spatial_ink_window::generation()
        })
        .ok_or("This visual capture is no longer active.")?;
    if let Some(shared) = &current.shared {
        shared
            .marks
            .lock()
            .unwrap_or_else(|value| value.into_inner())
            .pop();
    }
    let _ = app.emit_to(
        "spatial-ink",
        "o8:visual-capture-undo",
        serde_json::json!({"id": id, "generation": generation}),
    );
    Ok(())
}

#[tauri::command]
pub async fn o8_visual_capture_finish(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    id: String,
) -> Result<serde_json::Value, String> {
    main_only(&window)?;
    let (generation, session) = {
        let mut owner = lock_owner();
        let current = owner
            .as_mut()
            .filter(|value| value.id == id && value.ready && !value.finishing)
            .ok_or("This visual capture is no longer active.")?;
        current.finishing = true;
        (
            current.generation,
            current
                .session
                .take()
                .ok_or("The screen recorder is unavailable.")?,
        )
    };
    if crate::spatial_ink_window::generation() != generation {
        return Err(
            "Dictation changed during visual capture. Capture again in its original chat.".into(),
        );
    }
    let _ = app.emit_to(
        "spatial-ink",
        "o8:visual-capture-finish",
        serde_json::json!({"id": id, "generation": generation}),
    );
    let app_clone = app.clone();
    let correlation = id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let instruction =
            crate::spatial_ink_window::take_visual_instruction(generation, &correlation)?;
        if !crate::spatial_ink_window::disarm_visual(&app_clone, generation) {
            return Err("The capture owner changed.".into());
        }
        session.finish(instruction)
    })
    .await
    .map_err(|_| "Screen capture stopped unexpectedly.".to_string())
    .and_then(|result| result);
    let mut owner = lock_owner();
    owner
        .as_mut()
        .filter(|value| value.id == id && value.generation == generation)
        .ok_or("The capture owner changed. Keep the draft in its original chat.")?;
    result
}

#[tauri::command]
pub async fn o8_visual_capture_transcribe_audio(
    window: tauri::WebviewWindow,
    id: String,
    audio: String,
    mime: String,
) -> Result<serde_json::Value, String> {
    use base64::Engine;
    main_only(&window)?;
    if audio.len() > 14_000_000 {
        return Err("Capture audio is too large.".into());
    }
    let extension = match mime.as_str() {
        "audio/mp4" | "audio/x-m4a" => "m4a",
        "audio/wav" | "audio/x-wav" => "wav",
        "audio/webm" => "webm",
        "audio/ogg" => "ogg",
        _ => return Err("Unsupported capture audio format.".into()),
    };
    let (directory, cancelled, generation) = {
        let mut owner = lock_owner();
        let current = owner
            .as_mut()
            .filter(|value| value.id == id && !value.transcribing)
            .ok_or("This capture is unavailable or already transcribing.")?;
        current.transcribing = true;
        (
            current.directory.clone(),
            current.cancelled.clone(),
            current.generation,
        )
    };
    struct Processing(String, u64);
    impl Drop for Processing {
        fn drop(&mut self) {
            if let Some(owner) = lock_owner()
                .as_mut()
                .filter(|value| value.id == self.0 && value.generation == self.1)
            {
                owner.transcribing = false;
            }
        }
    }
    let _processing = Processing(id.clone(), generation);
    let correlation = id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(audio)
            .map_err(|_| "Invalid capture audio.")?;
        if bytes.is_empty() || bytes.len() > 10_000_000 {
            return Err("Invalid capture audio size.".into());
        }
        if cancelled.load(Ordering::Acquire) {
            return Err("Visual capture was cancelled.".into());
        }
        let source = directory.join(format!("narration.{extension}"));
        std::fs::write(&source, bytes).map_err(|_| "Could not save capture narration.")?;
        if cancelled.load(Ordering::Acquire) {
            return Err("Visual capture was cancelled.".into());
        }
        crate::visual_capture_media::run(&directory, "transcribe", &source, "", &cancelled)
    })
    .await
    .map_err(|_| "Timed speech processing stopped unexpectedly.".to_string())
    .and_then(|result| result)?;
    if !lock_owner()
        .as_ref()
        .is_some_and(|value| value.id == correlation && value.generation == generation)
    {
        return Err("The capture owner changed during transcription.".into());
    }
    Ok(result)
}

#[tauri::command]
pub async fn o8_visual_capture_cancel(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    id: String,
    discard: Option<bool>,
) -> Result<(), String> {
    main_only(&window)?;
    cancel_owned(app, id, None, discard.unwrap_or(true)).await
}

async fn cancel_owned(
    app: tauri::AppHandle,
    id: String,
    generation: Option<u64>,
    discard: bool,
) -> Result<(), String> {
    let capture = take_owner(&id, generation);
    if let Some(capture) = capture {
        capture.cancelled.store(true, Ordering::Release);
        if let Some(shared) = &capture.shared {
            shared.stopping.store(true, Ordering::Release);
        }
        crate::spatial_ink_window::disarm_visual(&app, capture.generation);
        let directory = capture.directory.clone();
        tauri::async_runtime::spawn_blocking(move || {
            drop(capture);
            if discard {
                let _ = std::fs::remove_dir_all(directory);
            }
        })
        .await
        .map_err(|_| "Capture cleanup stopped unexpectedly.")?;
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
    use super::*;
    #[test]
    fn capture_ids_are_bounded_correlations() {
        assert!(valid_id("frame-123-abcd"));
        for invalid in ["", "../other", "frame\nnext"] {
            assert!(!valid_id(invalid));
        }
        assert!(!valid_id(&"x".repeat(97)));
    }
    #[test]
    fn existing_artifacts_survive_failed_directory_creation() {
        let directory =
            std::env::temp_dir().join(format!("o8-visual-owned-{}", uuid::Uuid::new_v4()));
        create_private_directory(&directory).unwrap();
        let receipt = directory.join("recording.mp4");
        std::fs::write(&receipt, b"previous capture").unwrap();
        assert!(create_private_directory(&directory).is_err());
        assert_eq!(std::fs::read(&receipt).unwrap(), b"previous capture");
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
            0o700
        );
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn old_startup_cleanup_cannot_take_a_replacement_owner_with_the_same_id() {
        let cancelled = Arc::new(AtomicBool::new(false));
        let previous = lock_owner().replace(Owner {
            id: "frame-reused".into(),
            generation: 42,
            ready: false,
            finishing: false,
            session: None,
            shared: None,
            directory: PathBuf::new(),
            cancelled: cancelled.clone(),
            transcribing: true,
        });
        assert!(take_owner("frame-reused", Some(41)).is_none());
        assert!(take_owner("another-frame", Some(42)).is_none());
        assert!(!cancelled.load(Ordering::Acquire));
        assert!(lock_owner().as_ref().unwrap().transcribing);
        let current = take_owner("frame-reused", Some(42)).unwrap();
        assert_eq!(current.generation, 42);
        *lock_owner() = previous;
    }
}
