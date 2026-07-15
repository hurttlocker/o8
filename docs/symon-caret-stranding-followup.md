# Proposed follow-up: eliminate provisional-text stranding in live caret dictation

> STATUS: PROPOSED / NOT IMPLEMENTED (drafted 2026-07-15). This is a design for a
> future dedicated session with a disposable build and real-app AX testing. The
> shipping behavior today is the safe-degrade described under "Current behavior".
> Do not describe this as implemented.

## Problem

`src-tauri/src/live_dictation.rs` streams provisional Apple Speech partials into
the focused editable via Accessibility (`apply_partial` → `write_if_expected`).
At finalize, `finish()` writes the polished text over the last provisional value.

If focus LEAVES the captured field between the last partial and finalize (the
user tabs to another field, clicks another app, or the field's element changes),
`finish()` returns `FinishOutcome::Conflict` and the provisional text is left
**stranded** in the original field — we never roll it back.

## Why it happens

Every write goes through `write_if_expected`, which re-resolves the target via
`focused_element_for_pid(target.pid)` → `AXFocusedUIElement`. That returns
whatever is focused *now*. Once focus moves, the captured field (call it A) is no
longer the focused element, so `read_current` fails `target_matches` and the
write is refused. We can verify we're not clobbering the wrong field, but we also
can't REACH field A to clean it up, because we only ever address "the currently
focused element", never element A directly.

## Current behavior (safe degrade — this is what ships)

- No wrong-field write: `write_if_expected` verifies process + identity + current
  value == expected before any mutation.
- No double-insert: `finish` returns `Applied`/`Conflict`; the paste-outcome
  branch in `lib.rs` does not also paste on `Conflict`.
- Final text recoverable: `dictation_history::record` + `set_last_voice_transcript`,
  and the Conflict message tells the user to press Cmd+Opt+V.
- Rollback on cancel/error works ONLY while focus is still on A.

So stranding is a UX degrade, not a safety bug. That is why it was deferred out
of the live-dogfood batch.

## Proposed fix: address the captured element by retained ref

Store the captured `AXUIElementRef` in the `Transaction` so `finish()` and
`rollback()` can target element A directly, regardless of what is focused now.

Then:
- `finish()`: write the final text into A IFF A's current value == the last
  provisional we wrote (`expected_value`). Success ⇒ the final lands in the
  original field even though focus moved (this also ELIMINATES stranding). Any
  mismatch (user edited A, A destroyed) ⇒ fall back to today's Conflict + message.
- `rollback()`: restore A's original value by the same ref, same verify-first.

Fail-safe invariant preserved: **every** write still verifies current == expected
before mutating, so the worst case is exactly today's behavior.

## Required machinery (and why it's not unit-provable)

1. **Send wrapper.** The `Transaction` lives in a `static Mutex<Option<..>>`, so it
   must be `Send`. A raw `AXUIElementRef` / `core_foundation::CFType` is `!Send`.
   Need a newtype holding the retained ref with `unsafe impl Send` — justified by
   AXUIElement being documented thread-safe, but it IS an unsafe assertion.
   (`paste.rs::OwnedAxElement` is the retain/release pattern to copy, but it is
   not `Send` today.)
2. **Retain/release discipline.** `CFRetain` on capture, `CFRelease` on drop, exactly
   once each, panic-safe while the mutex is held. A leak or over-release is a
   crash/UAF that unit tests will not catch.
3. **Stale-ref handling.** A destroyed element / quit app makes AX calls return
   `kAXErrorInvalidUIElement`; treat as Conflict (no crash). Must be verified live.
4. **Cross-thread AX write to an UNFOCUSED element.** Some apps refuse `AXValue`
   writes to a non-focused element; per-app behavior must be probed on real targets.

Points 2–4 have no honest unit test — the real path needs a live AX element, so a
unit test would only re-encode the premise (our own reachability doctrine). This
work needs a manual AX harness on a disposable build, not `cargo test`.

## Manual test matrix (dedicated session, disposable build)

1. Dictate into TextEdit field A, then Tab to field B before releasing Fn →
   final lands in A, B untouched.
2. Dictate into field A, click a different app before finalize → final lands in A.
3. Dictate into A, then edit A by hand before finalize → Conflict + Cmd+Opt+V,
   no clobber of the user's edit.
4. Dictate into A, then close A's window before finalize → Conflict, no crash.
5. Cancel (recognizer error / brush) after partials in A, focus moved away → A
   rolled back to original.
6. Rapid A→B→A focus bounce during a long dictation → no wrong-field write, no leak
   (watch `leaks`/Instruments across many cycles).
7. Emoji / composed-char selection boundary in A (UTF-16) → no corruption.

## Files

- `src-tauri/src/live_dictation.rs` — `Target`/`Transaction` gain the retained ref;
  `capture_target_from_element`, `write_if_expected`, `finish`, `rollback` switch
  from focused-element resolution to ref-targeted writes (keeping the focused-element
  path as the capture source).

## Do NOT

- Do not land this behind a `cargo test`-only proof.
- Do not develop it against the operator's daily-driver build.
