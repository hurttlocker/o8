# Desktop build and deployment

o8 ships as a Tauri v2 desktop application containing the web frontend, the local Next.js server, the WebSocket bridge, native helpers, and the `o8` CLI.

## Prerequisites

- Node.js 22 and the repository’s npm dependencies.
- A current stable Rust toolchain.
- Xcode Command Line Tools for macOS builds.
- Signing and updater credentials only when producing a signed release; [`.env.example`](../../.env.example) documents the supported variables without embedding secrets.

Run `npm install` after cloning so JavaScript and native-module dependencies match the lockfile.

## Local development

- `npm run dev` starts the coordinated Next.js and WebSocket development stack.
- `npm run tauri:dev` starts the native shell and its coordinated local backend.
- `npm run desktop:dev:side` uses the side-by-side ports intended for installed-app bridge work.

Development ports are conveniences, not protocol constants. The packaged shell allocates ports dynamically and writes `~/.o8/api-port` and `~/.o8/ws-port`.

## Build pipeline

1. `npm run tauri:prebuild` exports the frontend and compiles the Node server bundles and helpers into `out/`.
2. `npm run tauri:build` creates an unsigned local production build.
3. `npm run tauri:build:signed` creates the signed, updater-capable build when the required credentials are present.

The export step keeps native modules external where required, copies runtime-read assets beside the server bundles, and packages the resources declared by `src-tauri/tauri.conf.json`.

## Verification

Before a release candidate:

```bash
npx tsc --noEmit
npm test
cd src-tauri && cargo check
```

Then complete the [pre-ship gate](PRE-SHIP-GATE-CHECKLIST.md) against a clean profile. Verify that the app launches its sidecars, resolves dynamic ports, opens the dashboard, and can complete a real governed packet path before treating the bundle as releasable.

## Release boundary

A local build or commit is not a release. Publishing uses the repository’s guarded ship workflow and requires explicit operator authorization in the current session. Keep signing material out of the repository, never run concurrent ship processes, and verify the published version and installer after notarization completes.
