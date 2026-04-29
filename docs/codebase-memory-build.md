# Vendoring `codebase-memory-mcp` (issue #739)

The Context Engine v2 (epic #738) ships the static `codebase-memory-mcp` binary inside the o8 Tauri bundle so the production app can index repos and answer recall queries without a separate install step. This doc explains how the binary gets vendored, how to upgrade the pin, and the size trade-off the orchestrator should be aware of.

## Source

- Upstream: [DeusData/codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) (MIT)
- Pinned version: `v0.6.0` (see `scripts/fetch-codebase-memory.mjs` `CMM_VERSION`)
- Distribution: prebuilt static binaries on the GitHub release page, four targets — `darwin-amd64`, `darwin-arm64`, `linux-amd64`, `linux-arm64`, plus a `windows-amd64` zip.

## How it ends up in the bundle

1. `npm run tauri:prebuild` runs `scripts/tauri-export.mjs`.
2. After the Next.js + MCP server bundles compile, the script invokes `node scripts/fetch-codebase-memory.mjs`.
3. The fetch script detects the host platform (`process.platform` + `process.arch`), downloads the matching tarball/zip from `github.com/DeusData/codebase-memory-mcp/releases/v0.6.0`, verifies the SHA-256 against the pinned checksum, extracts the binary, and writes it to `out/server/codebase-memory-mcp` (or `.exe` on Windows).
4. A sentinel file `out/server/.codebase-memory-mcp.version` marks the version + asset combo so reruns short-circuit.
5. Tauri's `bundle.resources` config (`tauri.conf.json` already maps `out/server/` → `Contents/Resources/server/`) ships the binary alongside the Node servers — no `tauri.conf.json` change required.
6. At launch, `src-tauri/src/lib.rs` looks for `<resource_dir>/server/codebase-memory-mcp{.exe}`. If found, it sets `O8_CODEBASE_MEMORY_BIN` on the spawned Next.js server's environment (and on the parent's env so any later child inherits it).

## Why a fetch script instead of committing the binary

Each architecture's binary is ~161 MB uncompressed. Committing all four (or even one) would either bloat every clone or push us into Git LFS storage costs. The fetch script keeps the repo clean and only ever materializes the binary for the current build host.

The fetch is **non-fatal** — if the runner is offline, the prebuild logs a warning and continues. The Tauri sidecar treats a missing binary as "feature unavailable" rather than a startup error, so a bundle without the binary still boots; it just can't serve the codebase-memory MCP tools.

## Bundle size impact

| Metric | Before | After (single arch) | Delta |
|---|---|---|---|
| Compressed installer (`.app.tar.gz`) | ~41 MB | ~69 MB | +28 MB |
| Installed `.app` on disk | ~148 MB | ~309 MB | +161 MB |

This **exceeds** the issue's stated `<30 MB` delta target on disk. The compressed download delta is in the same neighborhood as the issue's estimate (the binary compresses 5.7×). Two follow-up paths if the disk delta becomes a problem:

1. **Move to runtime download**: drop the build-time fetch and have the Tauri sidecar download the binary into `~/.cortex-ide/codebase-memory-mcp/<version>/` on first launch. Zero installer delta, costs the user a one-time ~28 MB network pull.
2. **Trim the binary**: the upstream binary is ~161 MB because it ships tree-sitter parsers for 66 languages plus a UI bundle. A custom build with a slimmed parser set would shrink the binary substantially. See upstream `Makefile` for the parser feature flags.

Both are out of scope for #739 — flagged here so the orchestrator can revisit if needed.

## Cross-compile fallback (when upstream lacks a target)

Upstream currently ships all four targets, so nothing to do. If a future release drops a target (e.g. drops `darwin-arm64` prebuilts), build from source:

```bash
git clone https://github.com/DeusData/codebase-memory-mcp.git
cd codebase-memory-mcp
git checkout v0.6.0
# Toolchain assumed: Go 1.22+. Adjust if upstream changes language.
GOOS=darwin GOARCH=arm64 make build
# Produces ./codebase-memory-mcp — copy into the o8 repo's out/server/
```

If we ever cross-compile, replace the corresponding entry in `CHECKSUMS` in `scripts/fetch-codebase-memory.mjs` with a SHA pinned against the artifact you produced (and keep that artifact in a private bucket the build host can reach).

## Upgrade procedure

1. Pick a new release on the upstream repo.
2. Bump `CMM_VERSION` in `scripts/fetch-codebase-memory.mjs`.
3. Pull the new `checksums.txt` from that release and replace the `CHECKSUMS` map entries.
4. `rm -rf out` and rerun `npm run tauri:prebuild` to confirm the fetch + extraction still works.
5. Run `cd src-tauri && cargo check --features dev-mcp-plugin` to make sure the Rust side compiles.
6. Smoke test the binary: `out/server/codebase-memory-mcp --version` should print the new version.
7. Note any new MCP tools / behaviour changes in the upgrade PR.

## What downstream issues need

- **#740 (`.mcp.json` registration)**: read `process.env.O8_CODEBASE_MEMORY_BIN`. If set, register an MCP server entry pointing the `command` field at that path (no args). If unset, omit the entry.
- **#742 (recall card)** + **#743 (dispatch injection)**: same pattern — gate on `O8_CODEBASE_MEMORY_BIN` being defined.
