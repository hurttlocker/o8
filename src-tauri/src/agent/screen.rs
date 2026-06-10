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
    let status = cmd.status().ok()?;
    if !status.success() {
        log::warn!("[symon-screen] screencapture exited with {status}");
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
    fn non_screen_prompts_do_not() {
        assert!(!wants_screen("Remind me to call Q at 3pm"));
        assert!(!wants_screen("Where is my meeting tomorrow?"));
        assert!(!wants_screen("What's shipping in o8?"));
    }
}
