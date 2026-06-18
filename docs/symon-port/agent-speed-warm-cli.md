# Symon agent speed — warm the Claude CLI (#1252 follow-up)

**Goal:** kill the dominant avoidable latency in the voice agent — `claude` CLI
bootstrap paid on *every turn*. Today `claude.rs::run_loop` spawns a FRESH proc
per turn and re-sends a growing transcript (author flagged it at claude.rs:283:
"a persistent REPL would send the schema once — deferred"). A K-tool task = K+1
cold boots + K re-prefills.

Operator: "do all the fixes." Status: shipping after the 0.1.382 frost fix.

## Design (one coherent change — the tiers interlock)

**`ClaudeSession`** (new, in `claude.rs`) — one `claude` proc, MANY turns:
- `spawn(bin, model, mcp_cfg)` boots the proc, holds stdin + a persistent BufReader.
- `send_turn(content) -> String` writes one user frame, reads stream-json until
  the `result` event, returns text, **keeps the proc alive** (no kill).
- `Drop` kills + reaps. Verified the multi-turn-one-proc pattern works (the
  additive-drawing CLI test: one proc, many user msgs, context retained).

**Tier 3 — persistent session per task** (`run_loop` rewrite):
- Turn 1: `send_turn(full prompt + image)`.
- Tool turns: `send_turn(ONLY the tool-result follow-up)` — model retains system
  + tools + prior turns natively, so NO transcript re-send. Kills re-boot AND
  re-prefill; makes multi-step tasks surer (context accumulates).

**`claude_pool.rs`** (new) — Tier 1 + Tier 2, ported from `warm-repl-pool.ts`:
- `prewarm(model)` tops up ≤1–2 idle booted procs (keyed by bin+model).
- `acquire(model)` hands one out (warm hit) or cold-spawns; refills in bg.
- Caps: MAX_LIVE (~4), idle reap (~10min). Agent procs are taken for a WHOLE
  task then dropped (they carry task state — never returned to the pool).

**Tier 1 hook:** `fn_hotkey.rs::begin_agent_dictation()` (Left-Option down edge,
keycode 58) → `claude_pool::prewarm("claude-opus-4-8")`. Proc boots during STT.
Only LEFT option (agent); Right option = Ask/Gemini, no claude prewarm.

**Secondary (cheap):** `gemini.rs` builds a fresh `reqwest::Client` per call
(:22, :221) → shared lazy `static` Client (keep-alive, no per-call TLS). Only on
the vision/read_screen path (off the all-Claude hot path), so low value but trivial.
NOTE: router.rs intent_classification/result_summarization are RESERVED/unused in
the V1 loop — the brainstorm's "two Gemini hops per task" does NOT fire. Ignore.

## Verify
- `cargo test --lib` (compile + units) — add a ClaudeSession multi-turn unit if
  cheap; otherwise a local one-off.
- Ship 0.1.383, operator tests live (turn-1 felt speedup + multi-step latency).
- Risk: rewrites the agent's core loop; if broken the whole agent breaks. Be careful.

## Concurrent-agent hazard
Another agent shares `target/` — cargo builds RACE ("could not write output … No
such file or directory" killed the first 0.1.382 ship). Re-run on race; serialize
my own cargo (don't edit Rust mid-build).
