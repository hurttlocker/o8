# Canvas tool-calling — handoff verification (for the next agent)

**Plan source of truth:** `docs/symon-o8-control-tuning.md` (the prior research). It's
accurate and the 4-phase plan is sound — build it. This file is a second-agent
verification pass against the LIVE code at **0.1.383**, plus gotchas.

## Verified against live code (0.1.383) — the research checks out

- ✅ `o8_canvas` has **no bare open/enter verb**. `CANVAS_VERBS` (`o8_bridge.rs:923`):
  send-prompt, ask-brain, open-browser, open-spec, spawn-terminal, search, zoom,
  dock. `canvas_intent` rejects anything else (`:975`) → a bare "enter" 400s today.
- ✅ Same 8 verbs in the schema enum (`tools/mod.rs:442`) and the route
  (`src/app/api/canvas/intent/route.ts:18`, rejects unknown at `:68`).
- ✅ `o8_ui_open` surface enum (`tools/mod.rs:548`) has **no `canvas`**: settings,
  voice_settings, mobile_qr, automations, browser, inbox, prs, activity, review,
  o8md, workspace, files, terminal. Strict enum → silent nearest-match → `workspace`
  → the o8 panel. The "open canvas → o8 panel" diagnosis is exactly right.
- ✅ Canvas-glass listener for `o8:canvas-intent`: `src/app/preview/canvas-glass/page.tsx:2435`.
- ✅ `o8:ui-command` listener: `src/app/dashboard/page.tsx:3743` — note it's a Tauri
  `listen()` (not `addEventListener`), a chain of `if (surface === '…')`. The silent
  fall-through (Phase 2) is real: an unmatched surface just does nothing.

## Line-number deltas (grep, don't trust)

- `tools/mod.rs`, `o8_bridge.rs`, `route.ts` refs in the plan are **exact** as of 0.1.383.
- `page.tsx` refs are ~6 lines low (the file shifted): ui-command listener is `3743`
  not `3749`; the silent fall-through is in the `3743→~3800` block, not `3786`.
  Grep `o8:ui-command` / `o8:canvas-intent` fresh.

## Blocker cleared

The plan said "build AFTER the warm-CLI speedup lands (same crate, main-only tree)."
**That shipped — 0.1.383 (commits `af842ed6` + the new `agent/claude_pool.rs`,
`ClaudeSession` in `claude.rs`).** The agent crate is free. Don't re-touch
`claude.rs` / `claude_pool.rs` / `gemini.rs` / `fn_hotkey.rs` — they're the speed work.

## Gotchas for the build

- **OpenAI strict-mode schema rule** (CLAUDE.md): the `o8_canvas` `inputSchema` top
  level must stay a plain `{type:object, properties, required}` — no oneOf/anyOf/allOf.
  Adding `"enter"` to the existing `verb` enum is fine; validate args in the handler.
- **`canvas_intent_body`** (`o8_bridge.rs:940`) builds `{verb, args, ensure:true}`. The
  `enter` arm = empty carry (the `ensure:true` nav IS the action). Mirror it in the
  route + canvas-glass listener (graceful no-op after nav).
- **Ship, don't dev-bridge, for the Rust verb.** TS-only bits (route, listener) hot-
  reload on dev-bridge 3010, but the Rust enum/verb needs a build. Ship flow:
  commit YOUR files only (explicit pathspec — another agent + the operator's `o8.md`
  share this tree), `git checkout src-tauri/Cargo.lock`, `npm version patch --force`
  (commits only the 4 manifests), `git push --follow-tags`, `npm run ship`. Build
  races on `target/` are transient → re-run. Live-verify each phase with
  `mcp__o8__o8_view_screenshot` after the prod app auto-updates.
- **Changelog filter** (CLAUDE.md): adding a verb to `o8_canvas` needs nothing. If
  Phase 4 adds a NEW tool name (`o8_ui_set`), add it to BOTH the sed filter and the
  blocklist in `.github/workflows/sync-changelog.yml`.

## Recommended scope

Phases 1–3 (close the canvas gap + fail-loud + vocabulary) = one ship — that's the
actual bug. Phase 4 (manipulation verbs: setTheme/surface/canvas-mode) = second ship.
