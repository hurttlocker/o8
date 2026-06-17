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
- **1c. `escalate` tool.** ✅ DONE (2026-06-16, commit `b4cd5704`). Added to `tools/mod.rs` (`all_tools()` schema + `dispatch_tool_call` case), classified ReadOnly in `safety.rs`. `target=claude_brain` → fire-and-forget `spawn_claude_task` + a synthetic ack telling the front brain to say "on it"; `target=orchestrator` → re-imposes the `o8_dispatch` confirm INSIDE the handler (escalate is ReadOnly, so the loop didn't card it — a worker spawn must never go silent) then delegates to `o8_bridge::dispatch`. `claude.rs` strips `escalate` from the background brain's tools (no self-re-escalation). → *verify:* cargo check clean ✅, 18 agent tests pass ✅.
- **1d. `spawn_claude_task()`.** ✅ DONE (2026-06-16, commit `b4cd5704`). Sibling of `spawn_agent` — own thread + current-thread runtime, forces `CLAUDE_BRAIN_MODEL` + a `claude-task-` id prefix, reuses ALL of `run_agent` via a `run_agent_inner(model_override, task_prefix)` refactor (zero duplication — screen/store/dock/point-tags/speak/notify all shared). → *verify (PENDING):* the **calendar→email acceptance demo** runs end-to-end in the prod app via `o8_view_*` — **gated on a clean tree for a ship**: a concurrent agent has uncommitted `entitlement/*` WIP, so a build/ship would bundle uncommitted work + race their version-bump. Hold the ship until the tree is clean (or the operator OKs bundling).
- **1e. Router slot (optional).** Add a `claude_brain` model id to `AgentModelConfig` so the CLI model is config-driven like the others. → *verify:* changing `~/.o8/agent_models.json` swaps the Claude model.

### Phase 2 — Two-tier routing polish
- ✅ DONE (2026-06-16). Added a "TWO-SPEED" instruction to `system_prompt()`: heavy multi-step tasks (combing many events/reminders, multi-app workflows, careful drafting) → `escalate(claude_brain)` + a quick ack; quick single-step asks → handle inline. **Verified against the live Gemini model** (API probe, `escalate_probe.py`): "calendar→summary email" and "organize+dedupe reminders" both chose `escalate`; "weather?" and "remind me to call mom" both chose the direct tool — no over/under-escalation.
- Quieter dock treatment for background Claude tasks ("working in the background") so they don't fight the live voice capsule. → *verify:* a background task + a new foreground Gemini turn coexist without visual collision.
- ✅ Concurrent-task safety DONE (2026-06-16): `confirm_registry_tests::resolving_one_task_leaves_a_concurrent_task_pending` — resolving one task's confirm leaves a concurrent task's pending (registry keyed by task_id). Quieter background-dock treatment is the remaining P2 item (needs the dock surface; can ride a UI pass with Phase 3).

### Phase 3 — Settings toggle (user control) — ✅ DONE 2026-06-16 (Pro-gating + live-test pending)
> **✅ Backend:** `voice_escalation: "off"|"auto"|"deep"` on `AgentModelConfig` (`router.rs`, serde-default "auto"); `tools::enabled_tools_for(escalation)` withholds `escalate` when "off"; both front brains read the policy → filter the tool + append `escalation_prompt_suffix()` ("deep" loosens the threshold). Unit-tested.
> **✅ Write path + UI:** `router::set_voice_escalation()` + Tauri commands `agent_get_escalation`/`agent_set_escalation` (lib.rs, registered) + bridge `agentGetEscalation`/`agentSetEscalation` + a **VoiceTab "05 — VOICE BRAIN" section** (3-state radio-card Off/Auto/Deep, Rams/inline/`--t-*`, "uses your Claude subscription"). `npx tsc` clean; cargo check clean. **Built Pro-AGNOSTIC** — the gating seam is the policy read; wrap it behind the entitlement flags when the Pro decision lands.
> **Remaining:** (1) the Pro-gating decision (coordinate with the entitlement work); (2) live verification (needs a ship — same gate as the acceptance demo).

**It's an escalation-POLICY toggle, not a brain-swap.** The two-tier design keeps Gemini as the always-on front; the toggle gates whether/when it hands off to the background Claude brain. Three states:
- **Off** — Gemini handles everything inline; `escalate(claude_brain)` is hidden from the tool schema (filter it out in the prompt builder, the same place `claude.rs` already filters it).
- **Auto** (default) — escalate heavy multi-step tasks (today's behavior).
- **Deep** — prefer the Claude brain for medium tasks too (looser escalation threshold via the system-prompt line).

**Persistence seam:** add `voice_escalation: "off" | "auto" | "deep"` to `AgentModelConfig` (`agent/router.rs`, already read by the loop from `~/.o8/agent_models.json`) — no new backend plumbing. The prompt builder reads it to (a) include/exclude `escalate` and (b) pick the threshold wording.
**UI:** a new VoiceTab section (radio-card trio, `AppearanceTab` `DictationInputModeToggle` styling — inline styles, `--t-*` tokens), labeled "uses your Claude subscription."
**OPEN — coordinate with the concurrent entitlement/monetization work:** the background Claude brain (deep, subscription-billed) is a natural **Pro** lever. Decide whether "Deep" (or the whole background brain) gates behind Pro via the `entitlement/*` flags the other agent is building. Resolve before building the UI.
→ *verify:* toggle persists; Off hides `escalate` (re-run the Gemini probe → no escalation); Auto/Deep change the threshold; styling matches Rams.

### Phase 4 — Give the better brain something to call (sibling track)
- **4a. Canvas-intent bridge → voice. ✅ DONE (2026-06-17).** New `o8_canvas` tool (`tools/o8_bridge.rs` `canvas_intent` + pure `canvas_intent_body` mapper) POSTs the model's flat verb-params to the already-built `/api/canvas/intent` route (`send-prompt`/`ask-brain`/`open-browser`/`open-spec`/`spawn-terminal`/`search`/`zoom`/`dock`). Schema in `all_tools()`, dispatch arm in `dispatch_tool_call()`, classed **ReadOnly** in `safety.rs` (changes the screen, never repo state; `send-prompt` is the same path as typing in the composer and the orchestrator's mutations stay gated downstream — no extra card). BOTH brains inherit it via `all_tools()`. cargo check clean; 4 `canvas_tests` unit tests pass (verb→nested-args mapping + key isolation). → *verify (live, post-ship):* "tell the orchestrator to fix the failing test" opens the canvas + messages the orchestrator.
- **4b. Screen reading** (vision-extract + chunked read-aloud) as a tool. **Design:** the Claude text-planner can't see images, but the Gemini front brain can — so a `read_screen` tool captures via `screen::capture()` then routes the PNG through Gemini-vision with an extract prompt, returning structured text to WHICHEVER brain called it (solves Claude-can't-see-images without MCP). → *verify:* "read me what's on screen" works from both brains.
- **4c. "Symon Draws"** — extend the `[POINT:x,y]` overlay protocol (`point_overlay.rs` `parse_tag_inner` + `PREFIXES` + `show_points`, and the `/point-overlay` route) to `[DRAW:rect]`/`[DRAW:arrow]` primitives so the brain can annotate the screen, not just point. Heaviest (Rust parse + frontend render); do last. → *verify:* a draw tag renders a box/arrow on the overlay.
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
