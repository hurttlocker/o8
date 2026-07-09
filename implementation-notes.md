# Implementation Notes

- Printed the current git branch: `inline/94832991060165-dogfood-no-op-print-the-current-git-br`.
- Printed the first line of `README.md`: `# o8`.

## Deviations

- Created this notes file despite the no-edit task: the packet explicitly requires `implementation-notes.md` at the worktree root.
- `scripts/dev.mjs` did not exist in this worktree, so I added it and rewired the existing package scripts to call it.
- Left `src-tauri/tauri.conf.json` unchanged because it was outside the packet-owned file list; `tauri dev` may still need a follow-up devUrl update to match the DEV API block.
- Left the broad `sidecar_lifecycle::reap_o8_orphans()` implementation untouched because this packet only owns `src-tauri/src/lib.rs`; the production port allocation path in `lib.rs` is now identity-gated.
