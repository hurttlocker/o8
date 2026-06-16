# Epic — Symon Two-Tier Brain (Gemini front · Claude background · orchestrator dispatch)

**Status:** ACTIVE — design locked 2026-06-16. Owner: Claude (main brain, orchestrator).
**North star:** Symon answers instantly on Gemini Flash and, for anything heavy, acks in voice ("on it") and hands the job off to a **subscription-billed Claude brain** that works in the background — calling Symon's native tools, lighting the dock as it goes, and speaking the result when done. Free for any user with a Claude subscription. No voice turn ever blocks on Claude.

**Acceptance demo (the bar — this is "done" for the core path):**
> Say: *"Symon, look at what's on my calendar this week and draft me an email to the team summarizing it."*
> → Gemini acks instantly via `escalate(target: claude_brain)`
> → background Claude calls `mac_calendar_list_events` (ReadOnly, no confirm) then `mac_mail_draft` (confirm card fires in dock, user approves)
> → Symon speaks *"Done — drafted that email."*
> One voice command, two-tool background sequence, one confirm gate, dock lit throughout, voice never blocked. Shipped to the prod app and verified live.

---

## The architecture — three tiers, one seam

| Tier | Brain | Role | Billing | Status |
|---|---|---|---|---|
| **1 — Front** | Gemini Flash (direct) | Always-on voice loop + classifier/dispatcher. Handles quick stuff inline; acks instantly and hands off heavy stuff. | Gemini key (free) | ✅ ships today |
| **2 — Background** | **Claude (subscription CLI, async)** | Heavy reasoning + multi-step tool sequencing (canvas/screen/Mac chains). Never blocks voice. | User's Claude Max/Pro sub (no metered API) | 🔨 this epic |
| **3 — Dispatch** | Orchestrator → Codex/agents | Actual repo/coding work. | Codex/Claude sub | ✅ exists (`o8_dispatch`) |

**The seam = a Rust-side `escalate(task, target)` tool.** Gemini calls it when a request is bigger than the fast path. `target ∈ {claude_brain, orchestrator}`. It (a) returns instant synthetic success so Gemini speaks its ack, and (b) fire-and-forgets the background worker. This is the existing "mutates git repo → orchestrator, else Symon direct" boundary, now with a middle tier inserted for heavy-but-not-code work.

**Why this shape:** latency is solved structurally — Gemini owns the fast path, so the Claude brain is *always async* and first-token latency stops mattering. That frees the bridge choice to optimize for correctness + code reuse instead of speed.

---

## LOCKED decision — the Rust↔Claude bridge (Option A-refined: Claude-as-text-planner)

> **Corrected 2026-06-16 by live fixtures** (`/tmp/o8-claude-fixtures/`, captured against `claude` 2.1.179). The design-pass's Option A assumed Rust could intercept Claude's `tool_use` on stdout and inject a `tool_result` on stdin. **The fixtures prove that's impossible: Claude Code owns tool execution** — a `tool_use:Bash` was immediately followed by a CLI-produced `tool_result` with no caller injection. The CLI reaches *external* tools only via MCP. So the original A (stdin tool-result injection) does not exist, and full native tool-use would force the MCP path (C) with its split confirm gate. We avoid both.

Build the Claude brain as **a new Rust tool-loop module `src-tauri/src/agent/claude.rs`**, modeled line-for-line on `gemini.rs::run_loop`, with **Claude as a text-mode PLANNER** rather than a native tool-caller:

1. Rust spawns the subscription-billed `claude --input-format stream-json --output-format stream-json` CLI (same binary + billing as `warm-repl-pool.ts`, `O8_CLAUDE_CODE_BIN`/`CLAUDE_BIN`) **with tools OFF** (`--strict-mcp-config` + empty MCP config, plus disallow built-ins — same "brain never uses tools" posture as the QA warm pool). Claude is pure text-in / text-out.
2. The prompt gives Claude the system persona + `tools::enabled_tools()` schema + conversation + results-so-far, and asks for **the next action as strict JSON**: `{"tool": "...", "args": {...}}` or `{"done": true, "say": "..."}`.
3. Rust parses that JSON and runs the action through the **same** `confirm_if_needed()` → `dispatch_tool_call()` path Gemini uses, emits the same `emit_agent_event()` dock events, appends the result, and loops (≤ `MAX_TURNS`).
4. On `done`, speaks via `tts::playback`.

**This is strictly simpler than the design-pass version and reuses more:** the Claude call is the existing text-only stream-json path (read the final `result.result` string — no `tool_use`-block parsing, no `tool_result` injection, no streaming-dedup gotcha). The loop, tool execution, and confirm gate are the *exact* Rust machinery Gemini already drives — **tools never leave Rust, the gate is untouched.** Claude's only job is to emit the next structured action; Claude is excellent at structured output, so the contract is robust.

**Spawn gotcha (from fixtures):** the Rust spawn must **keep stdin open until the `result` event arrives** — closing stdin at EOF immediately makes the CLI run SessionStart hooks and exit *without processing the turn*. (Production `one-shot-repl.ts` already does this: write the frame, end stdin only after the reader is attached.)

**Why not native tool-use via MCP (the would-be Option C):** it requires building a Rust-backed MCP surface + forwarding every call back to Rust for the gate — net-new infra that splits the safety boundary across processes, for a richer-but-unneeded agentic style. **MCP-native tool-use is the explicit graduation path** if the text-planner ever proves too limited (e.g. needs parallel tool calls or mid-stream reaction). For V1, text-planner mirrors `gemini.rs`'s proven one-tool-per-turn loop exactly.

---

## Phases — loopable, each with a verify gate

### Phase 0 — Design lock ✅ DONE (2026-06-16)
Brainstormer design pass locked Option A. This doc is the output.

### Phase 1 — Claude brain provider (the core path)
- **1a. Capture stream-json fixtures.** ✅ DONE (2026-06-16, `/tmp/o8-claude-fixtures/`). Findings: (i) **CLI owns tool execution** → text-planner design (above); (ii) **stdin must stay open until `result`** or the turn never runs; (iii) final answer is the `result` event's `result` string; `assistant` events carry `content:[{type:text|tool_use|thinking}]`. *(TODO: move fixtures into the repo as `cargo test` fixtures under `src-tauri/src/agent/` before 1b lands.)*
- **1b. `src-tauri/src/agent/claude.rs`.** ✅ DONE (2026-06-16). `run_loop` mirrors `gemini.rs`: per-turn `claude` spawn inside `spawn_blocking` (no tokio "process" feature needed), tools OFF (`--strict-mcp-config` + empty config, cwd=tmp), stdin held open until `result`, reads the `result` text, `extract_action()` parses `{"tool","args"}`|`{"done","say"}`, runs it through the existing `confirm_if_needed`→`dispatch_tool_call`, emits the same dock events, feeds the result into the next turn's transcript. Wired into `mod.rs` dispatch (`model.starts_with("claude")` → `claude::run_loop`) so `agent_models.json` `mac_native_action:"claude-sonnet-4-6"` selects it. **Verified:** `cargo check` clean; 4 `extract_action` unit tests pass; **real-model planner turn returned a clean `{"tool":"mac_weather","args":{}}` (num_turns:1, no built-in tool attempt).** Follow-ups noted in-file: persistent-REPL (schema sent once) + `--disallowed-tools` hard lock + per-turn-timeout process kill.
- **1c. `escalate` tool.** Add to `tools/mod.rs` (`all_tools()` + `dispatch_tool_call` case), classify in `safety.rs` (ReadOnly for `claude_brain`; `orchestrator` keeps the existing dispatch confirm). On `claude_brain`: return synthetic success + fire-and-forget `spawn_claude_task`. → *verify:* Gemini can call `escalate` and speak an ack.
- **1d. `spawn_claude_task()`.** Sibling of `spawn_agent` (~`agent/mod.rs:693`) — own thread + runtime, builds a fresh `TaskCtx` with a `claude-task-…` prefixed `task_id`, runs `claude::run_claude_loop`, emits dock events, speaks the result. → *verify:* the **acceptance demo** runs end-to-end in the prod app, verified live via `o8_view_*`.
- **1e. Router slot (optional).** Add a `claude_brain` model id to `AgentModelConfig` so the CLI model is config-driven like the others. → *verify:* changing `~/.o8/agent_models.json` swaps the Claude model.

### Phase 2 — Two-tier routing polish
- Tune Gemini's system prompt so it reliably recognizes "this is heavier than me → `escalate`" vs handle-inline (avoid over- and under-escalating). → *verify:* a handful of representative commands route correctly.
- Quieter dock treatment for background Claude tasks ("working in the background") so they don't fight the live voice capsule. → *verify:* a background task + a new foreground Gemini turn coexist without visual collision.
- Concurrent-task safety: test two active `task_id`s (foreground confirm + background confirm) through the `confirm_if_needed` registry. → *verify:* `cargo test` two-active-tasks case.

### Phase 3 — Settings toggle (user control)
- VoiceTab section: "Voice brain — Gemini Flash (fast) | Claude (your subscription, deeper tools)", plus an **escalation policy** (off / auto / always-prefer-Claude-for-heavy). Persist via the voice-prefs seam (`~/.o8/agent_models.json` is already read by the loop; wire the toggle to it). Label it clearly as "uses your Claude subscription." → *verify:* toggle persists and changes runtime escalation behavior; styling matches the Rams settings pattern (inline styles, `--t-*` tokens).

### Phase 4 — Give the better brain something to call (sibling track)
- Wire the **canvas-intent bridge** (`docs/symon-port/canvas-intent-bus.md`) to the voice path so Claude can open/arrange/drive canvas cards. → *verify:* a voice command opens + positions a canvas card.
- **Screen reading** (vision-extract + chunked read-aloud) as a tool. → *verify:* "read me what's on screen" works.
- *(A smarter brain calls tools better but can't call tools that don't exist — this track compounds with Phase 1–3.)*

### Phase 5 — End-to-end hardening + ship
- Full acceptance demo + the canvas/screen commands, shipped to prod, verified live; brief operator walkthrough. → *verify:* operator sign-off.

---

## Non-goals / guardrails
- **Gemini stays the fast front.** Do not put Claude in the blocking voice turn.
- **No Node route / no new MCP server for V1** (Option B/C). Revisit C only if a second non-Rust consumer needs the tools.
- **Don't rewrite the Gemini loop.** Surgical: `claude.rs` sits *beside* `gemini.rs`.
- **The confirm gate stays in Rust, in-process, untouched.** Every tool Claude calls is individually gated by the same cards. Destructive tools remain schema-hidden.
- Inline styles + `--t-*` tokens only on any UI (Phase 3).

## Risks (from the design pass)
1. **Claude's stream-json `tool_use`/`tool_result` block shape differs subtly from assumptions** (Anthropic-controlled format; the Node parser carries hard-won quirks). → De-risk in 1a: write `claude.rs` against *recorded fixtures*, lift only the block-shape knowledge from `stream-json-parser.ts` (~lines 340–405), skip the streaming/dedup machinery.
2. **A long background run leaves stale/colliding dock state** when a new foreground voice turn starts. → De-risk: distinct `claude-task-…` `task_id` prefix + quieter dock treatment + an explicit two-active-tasks test (Phase 2).

## Key files
`src-tauri/src/agent/claude.rs` (new) · `agent/gemini.rs` (the pattern to mirror) · `agent/mod.rs` (`run_agent`, `spawn_agent`, add `spawn_claude_task`) · `agent/tools/mod.rs` (`all_tools`, `dispatch_tool_call`, add `escalate`) · `agent/safety.rs` · `agent/router.rs` · `src/lib/claude-code/warm-repl-pool.ts` + `stream-json-parser.ts` (read-only reference for billing flags + block shapes) · `src/components/desktop/settings/VoiceTab.tsx` (Phase 3) · `docs/symon-port/canvas-intent-bus.md` (Phase 4).
