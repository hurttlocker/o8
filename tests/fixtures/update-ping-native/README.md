# Native update check tests

Run from the repository root:

```sh
node scripts/test-update-ping-native.mjs
```

This compiles the production update-ping module with Tauri's mock runtime and calls `check_app_update` through IPC. Real local HTTP servers exercise the updater transport and manifest parsing; a temporary settings file proves identity persistence across app instances. The runner uses the desktop lockfile. It does not launch the desktop app or its sidecars.

The fixture covers unreachable services, HTTP errors, redirects, malformed manifests, stalled response bodies, exact path and header fields, and the absence of ping headers on fallback requests and downloadable update resources. A signed installed-app update and the live service remain release verification boundaries.
