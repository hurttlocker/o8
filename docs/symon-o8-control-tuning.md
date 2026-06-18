# Symon o8-UI control — tuning to 98%

**Status:** **ALL PHASES BUILT.** Phases 1–3 shipped + live-verified in **0.1.384** (the `enter` verb so canvas has a home, fail-loud drift guard on unknown o8 surfaces, synonym vocabulary). Phase 4 (manipulation verbs) **BUILT + shipping in 0.1.385** — new `o8_ui_set` tool (keys: `theme` dark/light, `surface` glass/solid, `canvas_mode` on/off) routed through the same event bridge to the same setters the Settings controls call. The warm-CLI agent-speedup this was gated behind shipped in 0.1.383.

**Problem:** Symon controls o8's own UI by voice via a **semantic event bridge** (not clicking). The bridge is correct and should stay — but "open canvas" opened the o8 right panel. Root cause: "canvas" has no home in either control tool, and every miss is silent. Goal: ≥98% correct surface selection, plus extend from *reveal-only* to *operate*.

## Current mechanism (keep — do not add clicking)

- `o8_ui_open(surface)` → Rust emits `o8:ui-command` → dashboard listener (`src/app/dashboard/page.tsx:3749`) calls **the same handlers the buttons call**.
- `o8_canvas(verb)` → POST `/api/canvas/intent` → `o8:canvas-intent` CustomEvent → **the same handlers the canvas rail buttons call**; `ensure:true` full-navigates to `/preview/canvas-glass` first.
- Clicking (`o8_view_*` coords) is brittle (Retina px math, eval timeouts) — the bridge is strictly better. Deepen it; never add a click path.

## Root cause of "open canvas → o8 panel"

1. `o8_ui_open` has a **hard enum with no `canvas`** (`mod.rs:548`, `o8_ui.rs:18`): settings, voice_settings, mobile_qr, automations, browser, inbox, prs, activity, review, o8md, **workspace**, files, terminal. Strict-enum model → substitutes nearest legal value → almost certainly `workspace` → routes to `setRightPanelKind('o8') + setO8ActiveTab('workspace')` = **the o8 panel**. Exact match for the symptom.
2. `o8_canvas` *can* reach the canvas but has **no bare open verb** — verbs are action-only (send-prompt, ask-brain, open-browser, open-spec, spawn-terminal, search, zoom, dock; `o8_bridge.rs:924`, `match verb` :949). Navigation is only a side effect of an action. "Open canvas" maps to none.
3. Dashboard listener has **no canvas case** — `if (!tab) return` (`page.tsx:3786`) = silent no-op even if `surface:"canvas"` arrived.
4. Canvas is gated behind "Experimental: Canvas mode" (`route.ts:101`).

Net: navigation-only "show me the canvas" is expressible by **neither** tool, and every failure is silent → model guesses → panel tab.

## Phase 1 — Close the canvas gap (the actual bug). One owner: `o8_canvas`.

Decision: **`o8_canvas` owns ALL canvas; `o8_ui_open` owns window surfaces.** Do NOT add `canvas` to `o8_ui_open` (would split ownership).

- `src-tauri/src/agent/tools/o8_bridge.rs` — add `"enter"` to the VERBS list (:924) and a `match verb` arm (:949). No args; the action *is* the `ensure:true` navigation (empty `carry`).
- `src-tauri/src/agent/tools/mod.rs:442` — add `"enter"` to the `o8_canvas` verb enum; update the description (:438) so "open / enter / show / go to the canvas" → `enter`.
- `src/app/api/canvas/intent/route.ts:18` — add `'enter'` to `VERBS`.
- Canvas-glass `o8:canvas-intent` listener — ensure an `enter` verb is a graceful no-op after navigation (focus only; nav already happened). Add a tiny case if it currently warns on unknown verbs.

**Verify:** voice "open canvas" / "enter canvas" / "go to the canvas" → lands on `/preview/canvas-glass` (screenshot each).

## Phase 2 — Fail loud (stop silent substitution)

- `src/app/dashboard/page.tsx:3786` — replace `if (!tab) return;` with a toast/speech: "I don't know the o8 surface '<surface>'." Use the `ConfirmToastHost` `toast` primitive (added in the Tier-2 security pass) or a Symon speech event.
- **Keep the `o8_ui_open` enum for now** (Claude respects it; Phase 1 + Phase 3 remove the pressure to substitute). Only loosen `surface` to a validated string (→ `o8_ui.rs::open` already returns a helpful error) if substitution recurs on other words.

## Phase 3 — Vocabulary completeness (descriptions are the routing signal)

Audit real phrasings against the enum + verbs; add **synonyms to descriptions**, not new enums:
- `o8_ui_open` desc: name "diff / changes → review (or workspace)", "spec → o8md", "phone → mobile_qr".
- `o8_canvas` desc: name "open / enter / show / pull up the canvas → enter".
- Sweep operator phrasings: "open canvas", "enter canvas mode", "go to the diff", "show me changes", "pull up settings".

## Phase 4 — Manipulation verbs (the 98% unlock; second ship)

**BUILT (0.1.385)** as a new `o8_ui_set` tool (chose the separate-tool option below — keeps `o8_ui_open` = reveal, `o8_ui_set` = operate, mirroring the o8_canvas split). Keys: `theme` (dark/light) → `setPalette`; `surface` (glass/solid) → `setReduceTransparency('on'|'off')` (solid=on); `canvas_mode` (on/off) → POST `/api/panel/operator-defaults` `{experimentalCanvas}` (same call as the Settings toggle). `value` is a string for all keys (OpenAI strict-mode: plain object, validated in the handler). ReadOnly in `safety` (runs immediately, no confirm). Each maps to the SAME setter the Settings control calls. The plan below is the original spec.

Today Symon can only **reveal** surfaces — confirmed there is **no** `set-setting`/`toggle`/`setTheme` voice path anywhere. Add *operate*:

- `src-tauri/src/agent/tools/o8_ui.rs` — new `set_setting(app, args)` emitting `o8:ui-command` `{surface:"set", key, value}` (or a new `o8_ui_set` tool).
- `src-tauri/src/agent/tools/mod.rs` — schema: `key` enum (theme, surface, blur, canvas_mode, …) + `value`.
- `src/app/dashboard/page.tsx` listener — handle `surface:"set"` → call the SAME setter the Settings control calls (theme/appearance context: `setTheme`, `setSurface`, …).
- Scope tight to start: theme (dark/light), surface (glass/solid), enable Canvas mode. Expand later.
- Safety: a UI-preference set is a mutation but not destructive — no confirm card needed (same rationale as `open()` being ReadOnly is about destructiveness). Don't gate prefs behind approval.

**Verify:** voice "switch to dark mode", "make it solid", "turn on canvas mode" → control flips (screenshot).

## Ship plan

- Phases 1–3 = one small Rust+TS change → **one ship**.
- Phase 4 = **second ship**.
- Both AFTER the agent-speedup commit (avoid `main` working-tree + agent-crate collision; ship is whole-tree serialized).
- Live-verify each phase via `o8_view_screenshot` once auto-update lands.

## Source-of-truth note (prevents recurrence)

This bug *is* tool-vocab↔UI drift (canvas in the UI, absent from the tools). Longer term: a single shared surface list consumed by the Rust enum *and* the TS listener so a new UI surface gives Symon the verb for free.
