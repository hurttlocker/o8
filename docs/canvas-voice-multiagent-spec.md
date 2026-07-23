# Canvas voice + multi-agent — locked spec (2026-06-19)

Focused build spec for **voice-driven multi-agent on the canvas**, governed. Extends — does not replace — [`canvas-mode-vision.md`](./canvas-mode-vision.md) (the seven bets; bet #2 = HOTL gating) and [`canvas-mode-plan.md`](./canvas-mode-plan.md) (v1 + phased items). Locked from a fresh prior-art study (@a creator demo 2067729686000456183, 2026-06-18), a realtime-voice tech pass, and a strategy lock. Voice substrate context: [`voice-operator-vision.md`](./voice-operator-vision.md).

## What changed vs the 2026-06-11 the reference canvas app notes

New @a creator demo. **Real in the video:** voice → spawn 6 agents at once into an auto-tiled grid; voice → route a prompt to a *specific named* agent ("tell Chano to run the scan"); one compound sentence split across 3 agents in parallel; an agent spawning a **browser card** on the canvas to show its own output; dark glassmorphism; a tiny "Listening… / Attending…" status bar. **Claimed but NOT shown (marketing):** agents prompting *each other* (the demo is pure *parallel* execution — no agent↔agent, no graph/lines), **gpt-realtime-2** (the demo voice is push-to-talk, cascaded, voice-in/**text-out, no speak-back**), diagrams-by-voice, "ships to prod on VPS." And — as before — **zero governance**: every command executes instantly.

Takeaway: the operator's "bidirectional?" doubt is correct. the reference canvas app's "bidirectional" = agents acting on the *canvas/tools* (spawn a browser), not on *each other*. Our governed orchestrator→worker dispatch is already real agent-spawns-agent; theirs isn't shown.

## Positioning (locked) — lead with the brain, not "governed"

**Kill the frame "the reference canvas app but governed"** — it concedes their framing and front-loads the word that reads as friction. Lead with what they structurally cannot have:

> **"Direct an engineering org that already knows your codebase — by voice, across a canvas — and it never ships unreviewed."**

"Knows your codebase" (the Brain + organizational memory + self-review — already shipped) is the wedge. "Never ships unreviewed" (governance) is the closing reassurance, not the headline. The bigger differentiator is **it talks back AND remembers**; governance is just the most visible *proof* it knows things (it knows what's dangerous). the reference canvas app is a *spawner* with no memory, no review, no conductor — it can only create work, never answer a question about it.

## Priority (locked) — A before B, with feel baked into A

Two tracks. **Build A first, B immediately after.**

- **Track A — capability:** voice → spawn N agents onto the canvas + per-agent addressing + "ask the room", governed.
- **Track B — realtime feel:** gpt-realtime-2 / S2S (continuous, barge-in, speak-back).

**Why A first (decisive):** realtime is a *multiplier on capability, and a multiplier on zero is zero.* Ship S2S first and the most impressive demo is still "talk faster to the one lane I can already drive" — it closes neither gap (spawn, address) and burns the scariest COGS line (gpt-realtime-2 ≈ $32/$64 per 1M audio in/out tokens) before there's a capability worth multiplying. The the reference canvas app-beating mechanic (spawn many / address one / ask the room) must exist first.

**The concession to "realtime is the magic":** feel is a *first-class requirement of A*, not deferred. Ship A with (1) a **staging animation** — agents visibly assemble on the canvas (greyed "staging") while the one-sentence confirm is spoken — and (2) the **already-shipped spoken Preamble** ("let me line that up…", the "Let me check." filler that latches before read-tools) + the working-vs-waiting dock motion ported onto cards. Governed spawn then looks *more* alive than the reference canvas app's silent instant-spawn: their spawn has nothing on screen during the gap; ours has agents blooming.

## Governance tiers (locked) — observe everything, spawn freely, gate the irreversible few

This is bet #2 (HOTL) made concrete for voice multi-agent. Key off the **existing `SafetyClass` model** (`src-tauri/src/agent/safety.rs`: `ReadOnly` / `Reversible` / irreversible + `requires_confirmation`) — extend it, don't invent a new taxonomy. The default flips from gate-everything to gate-the-dangerous-few.

- **INSTANT / auto (no confirm):** ask-the-room / ask-brain (ReadOnly), status, highlight/point, steer an existing agent, and — **the linchpin — spawning a sandboxed agent into a git worktree.** A worktree spawn is a branch that touches nothing, costs nothing to kill, merges nothing → reversible by construction → it MUST NOT carry a confirm. This single decision is what makes governed voice-canvas feel *as fast or faster* than the reference canvas app: agents bloom the instant you ask, zero gate.
- **DRAFT-only (the draft IS the gate):** "tell the orchestrator to plan X" → orchestrator-draft injection (already shipped, ReadOnly). Compositional asks that produce a plan, not an action.
- **SPOKEN-CONFIRM + parameter read-back (Reversible):** the first real *commit of resources* — "spawn two agents and **start them executing** the auth refactor" → "two agents, auth refactor, Codex — go?" (the spawn is instant; the autonomous-execution kickoff on a real task is the gate). Also destructive shell, force-push, prod config. Spoken param read-back is already shipped — reuse it.
- **VISUAL approval card (always, regardless of voice):** merge, push-to-main, DB migrations, deletes, spend. Voice can mishear "yes" → the *binding* gate stays a visual glass confirm-card (the dock confirm-card pattern over the canvas, plan item #2). 

**Open question to verify in code before asserting "spawn = instant":** confirm the worktree-spawn path (`src/lib/lane/`) is genuinely side-effect-free (no network, no writes outside the worktree, cheap teardown). If true, spawn ships gateless. This is load-bearing for the whole "feels as fast as the reference canvas app" claim.

## Addressing (locked) — two-tier, orchestrator-default

the reference canvas app only has *flat* per-agent addressing ("tell Chano"). We have a conductor layer they lack — use it:

- **Default address = the orchestrator** for anything compositional: "split this across two agents", "what's everyone doing", "which of these will conflict". This tier is the structural advantage the reference canvas app can't copy.
- **Direct address = role/repo-based** ("the auth agent", "the o8-site agent") — self-documenting, survives mishearing. **Numbered ("agent two") as the unambiguous fallback** (cards carry a visible number). **Persona names optional** (we already have the Symon naming pattern) but NOT the primary model — cute in a demo, ambiguous at scale.

## The single sharpest differentiator (locked) — "Ask the room"

Voice + canvas + Brain + review, answered **out loud while pointing at the cards**:
- "What's everyone working on?" → highlights the cards + narrates.
- "Which of these will conflict?" → reasons over the live worktree diffs.
- "Is agent two's diff safe to merge?" → runs the review pass, tells you.

the reference canvas app structurally **cannot** do this (no memory, no review, no conductor). This is the one thing that makes our voice-canvas clearly *better*, not merely *safer* — and it's largely assemblable from shipped parts: Brain Q&A by voice, packet status, the review pass, the point/highlight overlay. **Make "ask the room" the headline demo.**

## Track A — build slices

Reuse, don't rebuild. The pieces exist; the gap is wiring + the spawn/address/ask flows.

1. **Canvas composer (persistent bottom bar)** — plan item #1; the product spine (the reference canvas app's always-present bar, not a modal). Mount the existing orchestrator composer slim at bottom-center, routed to the same thread plumbing; dispatching from it makes cards appear live.
2. **Voice → spawn agents onto canvas (INSTANT).** New verb path from the canvas intent bus (`/api/canvas/intent`, verbs in `src/app/api/canvas/intent/route.ts`; ConductorVerbs in `src/lib/voice/intent-types.ts`) → governed mission dispatch (`create_mission`/`dispatch_mission`) → cards render on canvas. Today voice `send-prompt` only messages the *active* lane — this adds true spawn. Staging animation while the (optional) spoken-confirm resolves.
3. **Per-agent addressing.** Resolve "agent two" / "the auth agent" / orchestrator to a target card/lane; route a steer to it. Cards carry a visible number + role label.
4. **"Ask the room."** Voice query → Brain/review over live lanes → spoken answer + card highlight overlay.
5. **HOTL confirm-card** (plan item #2) — floating glass card over canvas for the irreversible tier only.

### Verifiable success criteria (A)
- "spawn two Codex agents on the auth refactor" → two numbered cards stage then run, in worktrees, **no typed input**, gateless spawn, spoken param read-back before execution kicks off.
- "agent two, also run the linter" → steer lands on card #2 only.
- "what's everyone working on?" → cards highlight + a spoken, Brain-grounded summary.
- A merge attempt by voice still requires the visual confirm-card.

## Track B — realtime voice (immediate next; paid tier)

Facts current as of 2026-06 (verify pricing on platform.openai.com before locking COGS):

- **gpt-realtime-2** shipped ~May 7–8 2026: 128K ctx, `normal/high/xhigh` reasoning-effort, native interruptions, parallel tool calls, **"Preamble"** (model speaks an audible filler while a tool runs — masks gate latency natively), Agents SDK + remote MCP. **WebRTC** transport recommended for a desktop client — it auto-truncates unplayed audio on barge-in (interruption handled for you); WebSocket = manual truncate on `speech_started`. Pricing ≈ $32/1M audio-in, $64/1M audio-out tokens.
- **Governed tool execution maps cleanly — this is the load-bearing fact.** Client-defined **function tools NEVER auto-execute**: the realtime model only *emits* a `function_call` (name/args/`call_id`); our client decides whether/when to run it and send `function_call_output`. **The approval gate lives naturally in the gap before we return the result** — it can wait arbitrarily long (a click, a spoken "yes"). So realtime is *not* in tension with governance. (Remote-MCP tools have an even more explicit `mcp_approval_request`/`mcp_approval_response` handshake — but function tools keep more control in our client; prefer them for mutating verbs.)
- **Architecture:** realtime API owns the **audio loop only** (continuous mic, VAD/turn-detection, barge-in, speak-back). Every mutating capability is a client-side function tool routed through the §governance-tiers gate. Read-only (ask-the-room) executes immediately; mutating speaks a read-back + shows the card, then runs on "yes" or returns `{status:"rejected"}` so the model narrates the decline. Mask gate latency with the Preamble.
- **Claude has NO realtime API.** S2S must route STT + speak-back through OpenAI/Gemini/ElevenLabs while **Claude stays the reasoning/governance brain behind our intent router** — exactly our current cascaded split, just the STT/TTS ends upgraded. (ElevenLabs Conversational AI with BYO-Claude is the one managed path that keeps Claude-as-brain + managed turn-taking + client-tool gating, if we don't want to own the audio loop.)
- **Hybrid, matches our monetization ("free by default; pay only when o8 spends"):** **local NVIDIA Parakeet** STT (MLX/CoreML on Apple Silicon, ~2GB, WER ~8.1% beating Whisper-lg-v3, ~110× RTF, free/offline/private) as the **default** — a direct upgrade of the current cascaded pipeline (swap Whisper→Parakeet). **gpt-realtime-2 (WebRTC) as the opt-in paid "Realtime mode"** for barge-in + sub-300ms turn-taking + speak-back. Honest flag: Parakeet is batch/chunked — *barge-in/turn-taking is DIY on the local path*; the cloud path gives it for free. Don't try to make local Parakeet *feel* like gpt-realtime-2 on day one; ship it as a toggle.

### Pitfalls (write into the build)
- Turn-detection ≠ done-thinking — use the realtime API's turn model, not a naive silence timer.
- Barge-in must stop TTS instantly (free on WebRTC; manual on WebSocket).
- Never send a fake tool success before the action completes — the spoken narration would lie.
- Don't conflate the function-tool gate (implicit) with the MCP-approval gate (explicit).

## Naming
Their app is literally **"the reference canvas app"** — do **not** brand ours "the reference canvas app." Our surface is **Canvas mode** within o8.

## Sources (realtime pass, 2026-06)
OpenAI *Introducing gpt-realtime* + *Realtime conversations/tools/MCP* guides + client-events reference; webrtcHacks latency measurements; `parakeet-mlx` / FluidInference CoreML / arXiv 2509.14128 + Soniqo benchmarks; Anthropic Claude Code voice-mode (STT-only) coverage; Google Gemini Live API docs + 3.1 Flash Live blog; ElevenLabs client-tools docs. Uncertain/verify: exact gpt-realtime-2 date (May 7 vs 8) + per-token pricing (secondary aggregators; confirm on platform.openai.com), Gemini Live callable model id, Anthropic offline-voice roadmap rumor.

## Track B — build plan + gating (locked 2026-06-19)

Operator framing: *"Track B is where Symon becomes a real agent — all the tools to work with the human how the human wants, tunable interactions. Gate behind Founder, we proxy it, super-paid — but you can add your own OpenAI key so the devs of the world can have it too."*

### Gating (reconciled with o8's entitlement model — NOT a capability paywall)
o8's entitlement is **"monetize cost, not capability"** (`src/lib/entitlement/{types,flags}.ts`): every moat (incl. local voice) is free; the only paid lever is `proxy.inference` (pro/team). Realtime maps onto that, three paths (`src/lib/voice/realtime-access.ts`, `resolveRealtimeAccessWith`):
- **`byok` (FREE, everyone)** — user's own OpenAI key; they pay OpenAI, o8 never spends → no gate. *The path that works first.*
- **`managed` (paid "super-paid")** — no key + `proxy.inference` lever → o8 proxies + meters the realtime session. Gated by the existing flag + the server spend cap; `MANAGED_REALTIME_READY=false` until the proxy ships (route returns "coming").
- **`locked`** — neither → "add a key (free) or upgrade." Capability isn't withheld, only the cost path.
- **"Founder"** = the advanced voice tab (`src/app/voice-settings/tabs/FounderTab.tsx`, where ElevenLabs already lives), NOT an entitlement tier. Realtime mode's UI lives there.

### Architecture (recommended — confirm before Phase 3)
**Webview-WebRTC** session (OpenAI's blessed browser path), owned by the dock webview (`crate::dock_window`), NOT Rust `webrtc-rs`. Why: WebKit has getUserMedia + WebRTC + audio out; OpenAI realtime is designed for browser WebRTC with an ephemeral key. The hard part — the 41 Symon tools + the `confirm_if_needed` governance gate — already live in Rust (`src-tauri/src/agent/`); the webview session bridges `function_call`s back to Rust via a single Tauri command that reuses `dispatch_tool_call` + the confirm gate (the realtime model only *emits* a function_call; we hold it at the gate before returning the result — governance maps cleanly, per §Track B above).

### Phases
- **P1 — access resolver (DONE 2026-06-19):** `src/lib/voice/realtime-access.ts` + tests. The gating core, no I/O, no post-cutoff-API risk.
- **P2 — session-mint seam + Founder UI (DONE 2026-06-19, shipped 0.1.397):** `resolveOpenAIKey()` (byok-keys.ts), `openai` added to `/api/v2/keys` BYOK providers (encrypted), gated `POST /api/voice/realtime/session` (mints on BYOK / 403 locked / 501 managed), explicit default-deny middleware + route-coverage tests for `/api/voice/`, Founder "Realtime voice · beta" section (OpenAI key field + Test connection; no always-on toggle — that lands with P3). **Verified OpenAI realtime API (mid-2026, post-cutoff — use these, don't re-research):** mint = `POST https://api.openai.com/v1/realtime/client_secrets` (Bearer standard key; body `{expires_after:{anchor:"created_at",seconds},session:{type:"realtime",model,audio:{output:{voice}}}}`; ephemeral secret returns as **top-level `value`** = `ek_…` + `expires_at`). Model = **`gpt-realtime-2`** (GA flagship; `gpt-realtime`→pinnable `gpt-realtime-2025-08-28`). Browser handshake (P3): `RTCPeerConnection` + data channel **`oai-events`** + mic track → offer SDP `POST https://api.openai.com/v1/realtime/calls?model=gpt-realtime-2` (Bearer `ek_…`, `Content-Type: application/sdp`) → answer SDP. Tools: `session.update{tools:[{type:"function",name,description,parameters}],tool_choice}`; model emits `function_call` (name/arguments/call_id) on `response.done`; client returns `conversation.item.create{item:{type:"function_call_output",call_id,output}}` then `response.create` — **tools never auto-exec (the gate point)**. Barge-in auto on WebRTC. Pricing $32/$64 per 1M audio in/out.
- **P3 — live audio loop:** dock-webview RTCPeerConnection to gpt-realtime using the minted token; mic in, audio out, barge-in (WebRTC auto-truncates). Trigger switch: when realtime is on, the Option-hold agent path opens/holds the realtime session instead of the cascaded one (`src-tauri/src/fn_hotkey.rs` `begin/end_agent_dictation`).
- **P4 — tool bridge + governance:** realtime `function_call` → Tauri command → `agent::confirm_if_needed` (visual/spoken gate for the irreversible few) → `agent::tools::dispatch_tool_call` → return result on the data channel. Reuses the whole existing Symon tool surface.
- **P5 — managed proxy:** the metered `proxy.inference` path (flip `MANAGED_REALTIME_READY`); depends on the managed-inference proxy build.

Don't ship a dead toggle — hold the ship until P3 makes it actually talk (per the "UI in dev, backend ships" rule).
