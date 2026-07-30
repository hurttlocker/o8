# Vendoring `codebase-memory-mcp` (issues #739 / #755)

The Context Engine v2 (epic #738) ships the static `codebase-memory-mcp` binary so the production o8 app can index repos and answer recall queries without a separate install step. The binary is large (~161 MB per arch), so we **download it on first launch** rather than embedding it in the bundle. This doc covers where the binary comes from, how the download works, how to upgrade the pin, and what downstream issues need.

## Source

- Upstream: [DeusData/codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) (MIT)
- Pinned version: `v0.6.0` (see `CODEBASE_MEMORY_VERSION` in `src-tauri/src/lib.rs`)
- Distribution: prebuilt static binaries on the GitHub release page — `darwin-amd64`, `darwin-arm64`, `linux-amd64`, `linux-arm64` tarballs, plus a `windows-amd64` zip.

## How the binary ends up on disk (runtime download)

The binary is **not** included in the Tauri bundle. On first launch:

1. The Tauri sidecar (`src-tauri/src/lib.rs`) detects the host arch.
2. It probes `~/.o8/bin/codebase-memory-mcp` and compares a small sentinel file (`~/.o8/bin/.codebase-memory-mcp.version`) against the pinned `${CODEBASE_MEMORY_VERSION}-${asset_name}` tag.
3. **Cache hit** (sentinel matches, binary exists): set `O8_CODEBASE_MEMORY_BIN` to the path and emit `codebase-memory:status = "ready"`. No network.
4. **Cache miss**: emit `codebase-memory:status = "downloading"`, HTTPS-GET `https://github.com/DeusData/codebase-memory-mcp/releases/download/v${VERSION}/${asset_name}`, verify SHA-256 against the pinned constant in `lib.rs`, extract via system `tar` / `unzip`, copy to `~/.o8/bin/`, `chmod +x`, write the sentinel, set the env var, emit `"ready"`.
5. **On any failure** (offline, SHA mismatch, extraction error): log a warning, set `O8_CODEBASE_MEMORY_BIN=""`, emit `codebase-memory:status = "error"`. Downstream code (#740 onwards) treats empty as "feature unavailable" and omits the MCP entry.

The download runs on a background thread spawned during the Tauri builder's `setup` callback, so it never blocks app startup. Next.js boots in parallel.

The binary path is deterministic — `~/.o8/bin/codebase-memory-mcp{.exe}` — so downstream consumers can either resolve via the env var or re-check the filesystem at session spawn time. The latter is the more robust path because the env var only inherits into children spawned **after** the download completes.

## Why runtime-download instead of bundling

PR #754 explored the build-time fetch + bundle approach. Result: `o8.app` on disk grew from ~148 MB → ~309 MB (+161 MB), with the compressed installer growing from ~41 MB → ~69 MB (+28 MB). The compressed delta was acceptable, but +161 MB on disk blew the user's ~220 MB total app budget.

Runtime download keeps the installer at ~148 MB, costs the user a one-time ~28 MB network pull on first launch (~5s on broadband), and re-uses the cached binary on every subsequent launch with no startup cost.

## Bundle size impact

| Metric | v0.1.73 baseline | After #755 | Delta |
|---|---|---|---|
| Compressed installer (`.app.tar.gz`) | ~41 MB | ~41 MB | **0 MB** |
| Installed `.app` on disk | ~148 MB | ~148 MB | **0 MB** |
| `~/.o8/bin/` after first launch | n/a | ~161 MB | (out of bundle) |

## First-launch UX

- App opens, sidecar emits `codebase-memory:status = "downloading"` immediately.
- The download runs concurrently with Next.js boot. Wall time on broadband: ~3–5 s.
- When extraction completes, sidecar emits `codebase-memory:status = "ready"`. A future toast can subscribe to this event to surface a one-line confirmation.
- If the download fails, the app still boots normally; only the codebase-memory MCP tools are unavailable. Subsequent launches retry the download.

## Cross-compile fallback (when upstream lacks a target)

Upstream currently ships all four targets, so nothing to do. If a future release drops a target (e.g. drops `darwin-arm64` prebuilts), build from source:

```bash
git clone https://github.com/DeusData/codebase-memory-mcp.git
cd codebase-memory-mcp
git checkout v0.6.0
# Toolchain assumed: Go 1.22+. Adjust if upstream changes language.
GOOS=darwin GOARCH=arm64 make build
# Produces ./codebase-memory-mcp — drop into ~/.o8/bin/ and write the sentinel manually:
#   echo "0.6.0-codebase-memory-mcp-darwin-arm64.tar.gz" > ~/.o8/bin/.codebase-memory-mcp.version
```

Or for a real release replacement, repackage the binary into a tarball that matches upstream's `${asset_name}` and host it on a CDN the build host can reach, then update `codebase_memory_archive_sha()` to match the new SHA-256.

## Upgrade procedure

1. Pick a new release on the upstream repo.
2. Bump `CODEBASE_MEMORY_VERSION` in `src-tauri/src/lib.rs`.
3. Pull the new `checksums.txt` from that release and replace the entries inside `codebase_memory_archive_sha()`.
4. `cd src-tauri && cargo check --features dev-mcp-plugin` — must pass.
5. Bump the data dir cache by deleting `~/.o8/bin/.codebase-memory-mcp.version` so the next launch re-downloads.
6. Smoke test: `~/.o8/bin/codebase-memory-mcp --version` should print the new version.
7. Note any new MCP tools / behaviour changes in the upgrade PR.

## What downstream issues need

- **#740 (`.mcp.json` registration)**: read `process.env.O8_CODEBASE_MEMORY_BIN` first; if empty/unset, fall back to checking the deterministic path `~/.o8/bin/codebase-memory-mcp{.exe}`. If the binary exists at either, register an MCP server entry pointing the `command` field at that path with no args (the binary defaults to MCP-stdio mode when invoked bare). If neither resolves, omit the entry.
- **#742 (recall card)** + **#743 (dispatch injection)**: same pattern — gate the feature on whether the binary resolves. The path is stable and deterministic so a missed env-var inherit is not fatal.

## Failure surfaces (Tauri events)

The sidecar emits one of three states on the `codebase-memory:status` channel:

| Event payload | Meaning |
|---|---|
| `"downloading"` | Cache miss; HTTPS GET in flight |
| `"ready"` | Binary at `~/.o8/bin/codebase-memory-mcp` is verified and `O8_CODEBASE_MEMORY_BIN` is set |
| `"error"` | Download or verification failed; env var is empty; feature unavailable until next launch retries |

A future toast component can subscribe via `appWindow.listen('codebase-memory:status', ...)` and surface the state. Not strictly required for #755 acceptance.
