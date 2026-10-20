//! Native voice feedback belongs to the desktop shell even when its backend
//! is an existing development daemon. No server or recognizer is spawned here.
use tauri::{AppHandle, Emitter};

pub(crate) fn create(app: &AppHandle, api_port: u16) {
    crate::managed_voice_window::init(api_port);
    // Window creation must run on the main thread.
    let app_main = app.clone();
    let _ = app.run_on_main_thread(move || {
        crate::dock_window::create(&app_main, api_port);
        // Outside-the-window live agent-transcription HUD (bottom-center).
        // Same server-up prerequisite as the dock — it loads /agent-partials
        // on the same port.
        crate::agent_partials_window::create(&app_main, api_port);
        // Symon Spatial Context — the draw-on-screen ink overlay. Sized to
        // the cursor's monitor + mouse-captured only during an agent hold
        // (arm/disarm); click-through + transparent at rest.
        crate::spatial_ink_window::create(&app_main, api_port);
    });
    // Relay the canvas composer's partials-surface CLAIM directly to the HUD
    // window. The canvas emits it as a JS broadcast, and cross-webview
    // broadcasts can miss secondary windows (the dock's known failure mode,
    // 2026-07-08 live-hit: the HUD painted an empty bar over the canvas
    // because the claim never arrived). Rust listen → emit_to is reliable.
    //
    // CRITICAL: the forward MUST use a DIFFERENT event name. `listen_any`
    // hears EVERY emit — including this handler's own `emit_to` — so
    // re-emitting under the same name recursed until the thread's stack
    // blew (2026-07-09 crash ×2: EXC_BAD_ACCESS / stack_overflow abort on
    // tokio-rt-worker, triggered the moment the canvas claimed). The HUD
    // page listens for both the direct name and the `-fwd` relay name.
    #[cfg(target_os = "macos")]
    {
        use tauri::Listener;
        let relay = app.clone();
        app.listen_any("o8:agent-partials-claim", move |event| {
            if let Ok(payload) =
                serde_json::from_str::<serde_json::Value>(event.payload())
            {
                let _ = relay.emit_to(
                    crate::agent_partials_window::PARTIALS_LABEL,
                    "o8:agent-partials-claim-fwd",
                    payload,
                );
            }
        });
    }
    // JS → Rust listeners for the ink page (first-stroke capture trigger,
    // stroke payload at finalize, page-side disarm request).
    crate::spatial_ink_window::register_listeners(&app);
    // Stash the resolved port for the lazily-created Symon Points overlay
    // (point_overlay builds its window on first [POINT:...] tag, not here).
    crate::point_overlay::init(api_port);
}
