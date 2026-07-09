## Deviations

- Port-identity phase B (#1520): `scripts/dev.mjs` did not exist, so it was added and the
  package dev scripts rewired to call it.
- Port-identity phase B: `src-tauri/tauri.conf.json` left unchanged (outside the packet-owned
  file list); `cargo tauri dev` may need a follow-up devUrl update for the 47120 DEV block.
- Port-identity phase B: broad `sidecar_lifecycle::reap_o8_orphans()` untouched; the production
  port allocation path in `lib.rs` is identity-gated.

## Runtime expansion P1 notes

- Added Cursor CLI (`cursor`) and Grok Build (`grok`) adapters using the shared owned-session store and dispatch registry.
- Local CLI smoke skipped because `cursor-agent`, `grok`, and `grok-build` were not installed on this machine.
- Reused existing Cursor and Grok adapter scaffolding already present in this worktree; the conservative work was to close stale enum/docs surfaces instead of duplicating adapter files.
