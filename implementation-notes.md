## Deviations
- Added `src/components/desktop/workspace-terminal/XtermPanel.tsx` so `read-card` can return real terminal scrollback through the existing handle.
- Added `src-tauri/src/agent/tools/mod.rs` because Symon's model-visible `o8_canvas` verb enum and docs live there, while `o8_bridge.rs` owns the HTTP mapper.
- Brain/file read-back uses mounted card DOM text when component-local state is not lifted to page state; unmounted or empty content returns `content-unavailable`.
