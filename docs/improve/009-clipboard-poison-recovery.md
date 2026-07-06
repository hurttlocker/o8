# 009 — paste.rs: recover from poisoned CLIPBOARD_GUARD instead of panicking

## What & why
In `src-tauri/src/paste.rs`, the crate's own convention is that mutex poisoning must never break copy/paste: `PASTEBOARD_LOCK` (line 118) and `PREVIOUS_APP` (line 792) both recover via `unwrap_or_else(|e| e.into_inner())`, with rationale comments. But the two `CLIPBOARD_GUARD.lock().unwrap()` sites inside `paste_text()` (~lines 972 and 987 — the snapshot-preserve block and the `last_injected` write after `copy_to_clipboard`) violate it. One panic anywhere while that lock is held poisons it, and then **every subsequent `paste_text()` panics at the first lock site** — dictation paste is wedged until app restart. This compounds the known Symon clipboard-hijack bug area: the guard math itself is correct (verified), only the poison path is wrong.

## Exact change
- Replace both `CLIPBOARD_GUARD.lock().unwrap()` occurrences in `src-tauri/src/paste.rs` with the crate-standard `CLIPBOARD_GUARD.lock().unwrap_or_else(|e| e.into_inner())`, matching the style and comment convention of the `PASTEBOARD_LOCK` site at line 118.
- Sweep the rest of `paste.rs` (and only `paste.rs`) for any other bare `.lock().unwrap()` on these statics: `grep -n "lock().unwrap()" src-tauri/src/paste.rs` — fix any stragglers the same way.

## What NOT to touch
- The clipboard save/restore logic itself (change_count guard math) — it's correct; this plan is poison-recovery only. The deeper save/restore flaw tracked in the Symon clipboard-hijack bug memory is out of scope here.
- Any other file.

## Acceptance criteria
- `grep -n "lock().unwrap()" src-tauri/src/paste.rs` returns zero bare unwraps on the guard statics.
- `cargo check` and `cargo test` (in `src-tauri/`) pass.

## Verification
```bash
cd src-tauri && cargo check && cargo test
```
Live sanity: trigger one dictation paste in the dev app; clipboard restores as before.

## Failure path
This is a two-line change; if it somehow doesn't compile cleanly in 3 attempts, stop, revert, report — something about the static's type changed and needs a human look.

## Executor tier
Sonnet (trivial, mechanical). Reviewer pass still required (it's clipboard code).
