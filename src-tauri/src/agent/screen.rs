//! Screen context for the Symon agent lane (Clicky-parity dossier #2).
//!
//! When the user's prompt references the screen ("what's this error", "where
//! do I click"), capture the monitor under the cursor and attach it to the
//! Gemini request as `inline_data`, so the ONE Option gesture handles guidance
//! questions too. Capture is INTENT-GATED — no screenshot leaves the machine
//! unless the prompt asks about the screen (privacy + tokens).
//!
//! No image crates: `screencapture` (capture) + `sips` (downscale) + a manual
//! PNG IHDR parse for dimensions. Both ship with macOS. First capture triggers
//! the one-time Screen Recording permission prompt for o8 — expected UX for
//! this feature class; without the grant macOS yields wallpaper-only frames.
//!
//! The recorded geometry (image px + monitor logical bounds) is what
//! `point_overlay::show_points` uses to map the model's `[POINT:x,y:...]`
//! screenshot-pixel coords back onto the screen.

use base64::Engine;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

/// Fire the Screen Recording registration/prompt AFTER a failed capture.
/// Attempt-first on purpose: `CGPreflightScreenCaptureAccess` is unreliable on
/// recent macOS (observed returning false after a grant rebind even post-
/// relaunch), so the capture attempt itself is the truth — this only makes
/// sure o8 is registered in System Settings → Privacy & Security → Screen &
/// System Audio Recording so the user has something to toggle.
fn request_screen_permission() {
    // Safety: stateless CoreGraphics permission queries.
    unsafe {
        if !CGPreflightScreenCaptureAccess() {
            CGRequestScreenCaptureAccess();
        }
    }
}

/// Everything the request builder and the pointer transform need from one
/// capture: the image itself plus the monitor's logical geometry.
pub struct ScreenContext {
    pub png_base64: String,
    /// Screenshot dimensions in IMAGE pixels (post-downscale).
    pub img_w: u32,
    pub img_h: u32,
    /// Captured monitor's bounds in global LOGICAL points (Tauri top-left origin).
    pub mon_x: f64,
    pub mon_y: f64,
    pub mon_w: f64,
    pub mon_h: f64,
}

/// Downscale ceiling — 1440px wide keeps UI text legible to the model while
/// bounding the image at ~1-2k Gemini tokens.
const MAX_IMG_WIDTH: u32 = 1440;

/// Conservative cue list: every entry implies the user is talking ABOUT the
/// screen. Bare "where" is deliberately absent ("where is my meeting" must not
/// trigger a capture).
const SCREEN_CUES: &[&str] = &[
    "on my screen",
    "on the screen",
    "on screen",
    "my screen",
    "this screen",
    "see my screen",
    "can you see",
    "do you see",
    "what's this",
    "what is this",
    "what am i looking at",
    "looking at",
    "this error",
    "this warning",
    "this dialog",
    "this window",
    "this page",
    "this button",
    "this menu",
    "this app",
    "this setting",
    "where do i click",
    "where do i go",
    "where is the",
    "where's the",
    "point to",
    "point at",
    "point out",
    "show me where",
    "walk me through",
    "what does this say",
    "read this",
    // Draw / teach intents. These MUST capture the screen — not because the
    // model needs to read it, but because the overlay needs a coordinate system
    // (image dims + monitor geometry) to place [DRAW]/[POINT] tags, and the draw
    // protocol is only taught to the model when a ScreenContext rides the turn.
    // Without a capture here the model has no way to draw and falls back to
    // writing an HTML file. Bias toward capturing: easy drawing outweighs the
    // rare wasted screenshot on a non-visual "teach me" (honesty-guarded).
    "draw",
    "illustrate",
    "illustration",
    "sketch",
    "diagram",
    "teach me",
    "annotate",
];

/// Should this prompt get a screenshot? Lowercased substring match against the
/// cue list — cheap, conservative, errs toward NOT capturing.
pub fn wants_screen(prompt: &str) -> bool {
    let p = prompt.to_lowercase();
    SCREEN_CUES.iter().any(|cue| p.contains(cue))
}

/// Capture the monitor under the cursor (fallback: primary). Blocking
/// (~300-600ms of subprocess) — call it from the agent worker thread before
/// the loop starts, never from the main thread.
pub fn capture(app: &tauri::AppHandle) -> Option<ScreenContext> {
    let monitors = app.available_monitors().ok()?;
    if monitors.is_empty() {
        return None;
    }
    let cursor = app.cursor_position().ok();
    let monitor = cursor
        .and_then(|c| {
            monitors
                .iter()
                .find(|m| {
                    let p = m.position();
                    let s = m.size();
                    c.x >= p.x as f64
                        && c.x < (p.x + s.width as i32) as f64
                        && c.y >= p.y as f64
                        && c.y < (p.y + s.height as i32) as f64
                })
                .cloned()
        })
        .or_else(|| app.primary_monitor().ok().flatten())
        .or_else(|| monitors.first().cloned())?;

    // screencapture writes display 1 → first file, display 2 → second, in
    // CGDisplay order. That order isn't guaranteed to match Tauri's monitor
    // list, so capture ALL displays and pick the file whose pixel dimensions
    // match the target monitor (physical px == screenshot px). Identical twin
    // monitors would tie — first match wins (v1 limitation).
    let tmp = std::env::temp_dir();
    let stamp = std::process::id();
    let files: Vec<std::path::PathBuf> = (0..monitors.len())
        .map(|i| tmp.join(format!("o8-screen-{stamp}-{i}.png")))
        .collect();

    let mut cmd = std::process::Command::new("screencapture");
    cmd.arg("-x"); // no shutter sound
    for f in &files {
        cmd.arg(f);
    }
    let output = cmd.output().ok()?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        log::warn!(
            "[symon-screen] screencapture exited with {}: {} — if this is a \
             permission denial, grant o8 under System Settings → Privacy & \
             Security → Screen & System Audio Recording and relaunch",
            output.status,
            stderr.trim()
        );
        request_screen_permission();
        cleanup(&files);
        return None;
    }

    let want_w = monitor.size().width;
    let want_h = monitor.size().height;
    let picked = files
        .iter()
        .find(|f| png_dimensions(f).is_some_and(|(w, h)| w == want_w && h == want_h))
        .or_else(|| files.iter().find(|f| f.exists()))
        .cloned();
    let Some(path) = picked else {
        cleanup(&files);
        return None;
    };

    // Downscale in place if wider than the ceiling (sips preserves aspect).
    if png_dimensions(&path).is_some_and(|(w, _)| w > MAX_IMG_WIDTH) {
        let _ = std::process::Command::new("sips")
            .arg("--resampleWidth")
            .arg(MAX_IMG_WIDTH.to_string())
            .arg(&path)
            .output();
    }

    let (img_w, img_h) = png_dimensions(&path)?;
    let bytes = std::fs::read(&path).ok()?;
    cleanup(&files);

    let scale = monitor.scale_factor();
    let ctx = ScreenContext {
        png_base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
        img_w,
        img_h,
        mon_x: monitor.position().x as f64 / scale,
        mon_y: monitor.position().y as f64 / scale,
        mon_w: monitor.size().width as f64 / scale,
        mon_h: monitor.size().height as f64 / scale,
    };
    log::info!(
        "[symon-screen] captured {}x{} px ({} KB) of monitor at {},{} ({}x{} pt)",
        ctx.img_w,
        ctx.img_h,
        bytes.len() / 1024,
        ctx.mon_x,
        ctx.mon_y,
        ctx.mon_w,
        ctx.mon_h
    );
    Some(ctx)
}

/// Capture ONLY the o8 window (not the whole desktop) as a base64 PNG, for the
/// in-app feedback / error report (operator note, 2026-06-16). Region capture
/// via `screencapture -R` over the window's logical bounds keeps unrelated apps
/// out of a report; the operator can still remove the shot before sending.
/// Downscaled to MAX_IMG_WIDTH so a retina window stays under Discord's webhook
/// ceiling. Blocking subprocess — Tauri runs commands off the main thread, so
/// this is safe to call directly from the command. None on any failure → the
/// feedback flow falls back to a manual paste.
pub fn capture_window(app: &tauri::AppHandle, label: &str) -> Option<String> {
    use tauri::Manager;
    let window = app.get_webview_window(label)?;
    let scale = window.scale_factor().unwrap_or(1.0).max(1.0);
    let pos = window.outer_position().ok()?; // physical px, Tauri top-left origin
    let size = window.outer_size().ok()?;
    // `screencapture -R x,y,w,h` takes POINTS in the global display space (main
    // display top-left origin, y down) — same origin Tauri reports, so dividing
    // physical px by the scale factor yields the region to grab.
    let x = pos.x as f64 / scale;
    let y = pos.y as f64 / scale;
    let w = size.width as f64 / scale;
    let h = size.height as f64 / scale;
    if w < 1.0 || h < 1.0 {
        return None;
    }

    let path = std::env::temp_dir().join(format!("o8-feedback-{}.png", std::process::id()));
    let output = std::process::Command::new("screencapture")
        .arg("-x") // no shutter sound
        .arg(format!("-R{x:.0},{y:.0},{w:.0},{h:.0}"))
        .arg(&path)
        .output()
        .ok()?;
    if !output.status.success() {
        log::warn!(
            "[feedback-capture] screencapture failed ({}): {} — grant o8 Screen \
             Recording in System Settings if this is a permission denial",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        );
        request_screen_permission();
        let _ = std::fs::remove_file(&path);
        return None;
    }

    if png_dimensions(&path).is_some_and(|(w, _)| w > MAX_IMG_WIDTH) {
        let _ = std::process::Command::new("sips")
            .arg("--resampleWidth")
            .arg(MAX_IMG_WIDTH.to_string())
            .arg(&path)
            .output();
    }

    let bytes = std::fs::read(&path).ok()?;
    let _ = std::fs::remove_file(&path);
    if bytes.is_empty() {
        return None;
    }
    Some(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

fn cleanup(files: &[std::path::PathBuf]) {
    for f in files {
        let _ = std::fs::remove_file(f);
    }
}

/// Width/height from the PNG IHDR chunk (bytes 16..24 after the 8-byte
/// signature + 4-byte length + "IHDR"). Avoids pulling an image crate for two
/// big-endian u32 reads.
fn png_dimensions(path: &std::path::Path) -> Option<(u32, u32)> {
    let mut buf = [0u8; 24];
    let mut file = std::fs::File::open(path).ok()?;
    std::io::Read::read_exact(&mut file, &mut buf).ok()?;
    if &buf[0..8] != b"\x89PNG\r\n\x1a\n" || &buf[12..16] != b"IHDR" {
        return None;
    }
    let w = u32::from_be_bytes([buf[16], buf[17], buf[18], buf[19]]);
    let h = u32::from_be_bytes([buf[20], buf[21], buf[22], buf[23]]);
    Some((w, h))
}

/// Which Gemini model reads the screen. Vision must hit Gemini (the Claude
/// text-planner can't see, and OpenRouter ids here aren't assumed multimodal),
/// so reuse the user's configured front-brain model when it IS a Gemini id, else
/// fall back to the proven default the front brain already sends screenshots to.
fn vision_model() -> String {
    let configured = super::router::load_config().mac_native_action;
    if !configured.contains('/') && configured.starts_with("gemini") {
        configured
    } else {
        crate::models::GEMINI_3_FLASH_PREVIEW.to_string()
    }
}

/// `read_screen` tool — give the (text-only) brain SIGHT. The Gemini front brain
/// already sees the screen inline, but the Claude background text-planner can't;
/// this routes a screenshot through `gemini::vision_extract` and returns the
/// extracted text to WHICHEVER brain called it (no MCP surface needed). Prefers
/// the screenshot already captured for this task (intent-gated), else grabs one
/// on demand. ReadOnly in `safety` — observation only; capture is permission-
/// gated by macOS Screen Recording.
pub async fn read_screen(ctx: &super::TaskCtx, args: serde_json::Value) -> Result<serde_json::Value, String> {
    let focus = args
        .get("focus")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    let png = if let Some(screen) = &ctx.screen {
        screen.png_base64.clone()
    } else {
        let app = ctx.app.clone();
        let captured = tokio::task::spawn_blocking(move || capture(&app))
            .await
            .map_err(|e| format!("screen capture task failed: {e}"))?;
        match captured {
            Some(s) => s.png_base64,
            None => {
                return Err("I couldn't capture the screen — turn on Screen Recording for o8 in \
                            System Settings → Privacy & Security."
                    .to_string())
            }
        }
    };

    let prompt = match &focus {
        Some(f) => format!(
            "You are reading the user's Mac screen for a voice assistant. Focus on: {f}. \
             Answer concisely and spoken-ready (no markdown). If that isn't visible, say so."
        ),
        None => "You are reading the user's Mac screen for a voice assistant. Describe what's on \
                 screen — the active app/window and the key text or state the user would care \
                 about. Concise and spoken-ready (no markdown, a few sentences)."
            .to_string(),
    };

    let text = super::gemini::vision_extract(&vision_model(), &prompt, &png).await?;
    Ok(serde_json::json!({ "screen_text": text }))
}

#[cfg(test)]
mod wants_screen_tests {
    use super::wants_screen;

    #[test]
    fn screen_questions_trigger() {
        assert!(wants_screen("What's this error on my screen?"));
        assert!(wants_screen("Where do I click to export?"));
        assert!(wants_screen("Can you see this dialog?"));
        assert!(wants_screen("Point to the save button"));
    }

    #[test]
    fn draw_and_teach_intents_trigger() {
        // These need a capture so the overlay has a coordinate system to draw in.
        assert!(wants_screen("Can you draw that as an illustration?"));
        assert!(wants_screen("Teach me the Pythagorean theorem"));
        assert!(wants_screen("Sketch a triangle for me"));
        assert!(wants_screen("Draw a diagram of how this works"));
        assert!(wants_screen("Annotate the chart"));
    }

    #[test]
    fn non_screen_prompts_do_not() {
        assert!(!wants_screen("Remind me to call Q at 3pm"));
        assert!(!wants_screen("Where is my meeting tomorrow?"));
        assert!(!wants_screen("What's shipping in o8?"));
    }
}
