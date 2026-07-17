## Deviations

- Used a short timeout chain for idle backfill because it is reliable in the Tauri webview where `requestIdleCallback` is not guaranteed.
