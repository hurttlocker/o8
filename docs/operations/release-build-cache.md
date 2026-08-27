# Release build cache

Changed desktop releases reuse verified compiler intermediates from a local, content-addressed cache. The cache accelerates work while preserving the release pipeline's existing signing, notarization, publication, and exact-output checks.

## Cached phases

The build wrapper caches three generated trees:

- Web compiler state under `.next/cache`.
- Speech helper compiler state under `src-tauri/sidecars/speech-local/.build`.
- Native release compiler state under `src-tauri/target/release`, excluding `bundle/`, exported `server/`, and cache receipts.

Final applications, installers, exported server output, signatures, notarization tickets, and publication state are never cache inputs or cache outputs. A warm build still runs every normal build phase. Restored compiler state only gives those tools an incremental starting point.

## Identity and trust boundary

Each entry has two identities:

1. The compatibility identity covers the phase, platform, architecture, release mode, command options, toolchain versions, lockfiles, build recipes, target contract, relevant hashed build-time environment values, and hashes of the production env files loaded by the frontend build.
2. The full entry identity adds the Git commit, Git tree, and clean-worktree state.

A different source tree may reuse an entry only when the compatibility identity matches. Dirty worktrees bypass both restore and capture, except for the operator-owned `o8.md` review surface.

Cache directories and files are private to the local user. Before extraction, the build verifies the entry schema, compatibility identity, target contract, archive size, SHA-256 digest, and every archived path. Extraction happens in a quarantine directory, and restored trees may not contain symbolic links. A missing, corrupt, incompatible, or unreadable entry becomes a cache miss and the normal cold build continues.

This verification detects corruption and metadata mismatch. It does not turn an external cache provider into a trusted release authority. Any future remote transport must retain the verifier and add its own authenticated distribution boundary.

## Operation

`npm run tauri:build`, `npm run tauri:build:signed`, and `npm run tauri:build:nonotary` use the shared cache automatically. The default root is `~/.o8-build-cache/release-v1`.

Set `O8_RELEASE_BUILD_CACHE_DIR` to isolate a canary or move the cache to another local volume. Set `O8_RELEASE_BUILD_CACHE=off` to bypass restore and capture without changing the build command.

The cache retains one source entry for each compatibility identity and the two newest compatibility identities for each phase. This bounds the large native and web intermediates while preserving the most useful rollback point.

## Receipts

Every wrapped build writes a JSON receipt under `<cache-root>/receipts/`. It records:

- Exact, compatible, missed, or bypassed restore status for each phase.
- Restore and build duration for each phase.
- Verified archive bytes restored.
- Estimated build time saved from the producer receipt.
- Overall build outcome and elapsed time.

Receipts contain hashes and aggregate measurements, not repository or cache paths.

## Cold and warm canary

Use an isolated cache root and a clean source tree:

```bash
O8_RELEASE_BUILD_CACHE_DIR=/tmp/o8-release-cache-canary npm run tauri:build -- --no-bundle -- --features dev-mcp-plugin
```

Run once from one clean commit, then run the same command from a different clean source commit with unchanged toolchains, lockfiles, build recipes, environment, and command options. The first receipt should report three misses. The second should report compatible hits for web, speech, and native. Both builds must complete normally; a cache hit alone is not a release receipt.
