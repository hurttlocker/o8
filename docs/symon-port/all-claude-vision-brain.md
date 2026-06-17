# Symon all-Claude vision brain — Opus 4.8 sees the screen (sub-billed)

**Status:** verified + building (2026-06-17). Operator: "all Claude, Opus 4.8 adaptive, it can see — build it."
Foundation epic under which #1250 (precise targeting) and #1251 (teaching mode) ride.

## Verified live (2026-06-17, CLI v2.1.179, the "we need to check this")

`claude -p --input-format stream-json --output-format stream-json --verbose --model claude-opus-4-8`
with an `image` content block (base64 PNG) → **Opus 4.8 accurately described the actual screen**
(terminal windows, the o8 project, desktop icons, an AirDrop dialog, a notification). Auth is Claude
**Max** (`authMethod: claude.ai`) → **subscription-billed, zero API spend** (as long as
`ANTHROPIC_API_KEY` is unset). `-p`/`--print` is NOT deprecated — it was only retired in o8's
orchestrator layer, not the CLI. The capability may change upstream later; it works now.

## The decision

Make **Opus 4.8 the primary voice brain** — it's the stronger model AND it sees the screenshot
directly, so it both reasons and localizes better than Gemini, on the subscription. **Gemini Flash
stays as a fast-path toggle** for quick, simple asks where latency matters more than quality. Spoken
fillers mask Claude's latency (already shipped — the `FILLERS` rotation).

Today the front brain defaults to `gemini-3-flash-preview` (router `mac_native_action`); Claude is only
the async background brain, deliberately built text-only with Gemini as its eyes. This flips that:
Claude becomes the front brain and gets its own eyes.

## What changes (the build)

### 1. Model → Opus 4.8 (adaptive)
- `CLAUDE_BRAIN_MODEL` `claude-sonnet-4-6` → `claude-opus-4-8` (the Claude brain, front + background).
- "Adaptive" = Opus 4.8's adaptive reasoning (default). If the CLI exposes a reasoning/effort flag,
  pass adaptive; otherwise the model default is adaptive.

### 2. Vision on the Claude path (the core)
`claude.rs` already spawns interactive stream-json and re-sends the transcript per turn, sub-billed.
The text-planner pattern stays (tools live in Rust; Claude returns `{"tool","args"}` / `{"done","say"}`
JSON — no MCP tool-exec needed). Vision is additive:
- **`build_first_prompt`**: when `ctx.screen` is `Some`, append `screen_prompt_section(img_w, img_h)`
  (today it's deliberately omitted with a "can't see" comment — remove that, it's now false). This
  teaches Opus the image dimensions + the `[POINT]`/`[DRAW]`/teaching-primitive protocol.
- **`claude_text_turn_blocking`** (first turn only): change the user frame `content` from a plain
  string to a content array — `[{type:text,text:prompt}, {type:image,source:{type:base64,
  media_type:image/png, data:<screen.png_base64>}}]` — when a screenshot rides the turn. Subsequent
  follow-up turns stay text-only (the image was seen on turn 1; re-sending wastes tokens/latency).
- **Draw tags ride the `say`**: Opus emits `[POINT]/[DRAW]` inside the final `{"done":true,"say":"…"}`
  text; `run_agent_inner` already runs `parse_point_tags` on `result_text` regardless of brain, so the
  overlay path is unchanged. Add one line to the planner contract: "put any [POINT]/[DRAW] tags inside
  the say text."

### 3. The toggle (all-Claude vs Gemini fast-path)
- Config: `mac_native_action` already selects the front brain — `claude-opus-4-8` = all-Claude,
  `gemini-3-flash-preview` = fast-path. Make all-Claude the default.
- UI: a VoiceTab control ("Voice brain: Claude (best) / Gemini (fast)") writing `mac_native_action`.
  Pro-agnostic (free in beta).

### 4. Latency
- Fillers already fire; ensure they fire on the Claude path too (Opus + per-turn spawn is seconds).
- **Warm pool (follow-up):** o8 has `warm-repl-pool.ts` for the Brain. A pre-spawned `claude` pool for
  the voice brain removes the per-turn cold-spawn — the biggest latency win. Scope as phase 2.

## Phases

- **P1 — Opus + vision (core).** Model swap + image block + screen prompt on the Claude path. *Verify:*
  with `mac_native_action=claude-opus-4-8`, "what's on my screen?" → Opus answers from the screenshot
  (no Gemini); "box the Save button" → Opus emits a `[DRAW]` tag that renders.
- **P2 — toggle UI + latency.** VoiceTab brain selector; confirm fillers on the Claude path; warm pool.
- **P3 — converge with the draw epics.** Opus composes teaching diagrams (#1251) and feeds the AX-snap
  (#1250). Better brain → better tags into both.

## Decisions / risks

- **Latency is the real cost** — Opus via per-turn CLI spawn is seconds. Fillers + warm pool are the
  mitigations; the toggle lets the operator drop to Gemini when speed matters.
- **Vision localization is still imperfect** — even Opus won't pixel-place an existing UI control from a
  screenshot perfectly; #1250 (AX snap) remains the precision layer. Opus mainly wins on reasoning +
  teaching-draw on blank space (#1251) + understanding the screen.
- **Keep `ANTHROPIC_API_KEY` unset** for the spawned `claude` (force subscription billing). The voice
  spawn should scrub it from the child env as a guardrail.
- **Interactive vs `-p`:** claude.rs uses interactive stream-json today (works, sub-billed). The image
  block uses the same message schema; if interactive ever rejects images, `-p` print mode (verified to
  accept them) is the fallback since each turn is already one-shot (transcript re-sent).
- **Planner pattern retained** — no MCP tool-exec rebuild; tools stay in Rust. The "graduation" to
  MCP-native tool-use stays a later option.
