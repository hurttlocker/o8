# Phone ↔ Symon conversation — desktop/mobile contract (HISTORICAL PROPOSAL)

Status: **SUPERSEDED for the voice path — see `docs/symon-agent-mode.md`, the AUTHORITATIVE contract that actually shipped** (phone-hosted WebRTC voice: mobile `84a975c`, desktop `8edbfe16`, live e2e in v0.1.566). Disposition of this document's sections:

| Section | Disposition |
|---|---|
| v1 phone-text-first (`{action:"say"}` → `agent_run`, text replies, WS `symon` relay of `agent_tasks`) | **PROPOSED, unbuilt** — still the valid design for the async/text conversation complement to voice (works on cellular without a live WebRTC session; conversation persists as a thread) |
| Confirm bridge (`symon-confirm` into the mobile ApprovalStack + `{action:"confirm"}`) | **PROPOSED, unbuilt** — the named follow-up for phone-side approval of Symon's gated actions; referenced by symon-agent-mode.md §tool-relay |
| "v2: phone-hosted S2S" exclusion | **DEAD as written** — it shipped first, as the authoritative contract |
| Ground-truth section (seam pointers) | Superseded by fresher scouting; trust code over this snapshot |

Original intent preserved below for the still-proposed sections. Desktop seams were verified against code 2026-07-08.

## Ground truth (verified)

- Today's mobile Symon tab (`o8-mobile/src/app/symon.tsx` → `POST /api/mobile/symon`) is a **remote power toggle** for the Mac-side S2S session — mic, WebRTC, and TTS all live on the iMac. No phone-side conversation exists.
- Text into the brain loop exists as Tauri cmd `agent_run(prompt)` (`src-tauri/src/lib.rs:3927` → `agent::spawn_agent` → `run_agent`), webview-IPC-only today; the `/api/mobile/symon` route already demonstrates the eval-bridge pattern to reach webview/IPC from a gated route.
- Symon task results already persist to `~/.o8/agent.db` `agent_tasks` (`intent_text`, `result_text`, `tool_calls_json`, `status`, `ts`) and emit `o8:agent-task-event` (webview-only).
- Symon's safety confirms (`confirm_if_needed`) render dock cards **on the Mac only**, answered by Tauri cmd `agent_confirm(task_id, allow)`; unanswered confirms auto-decline at 2 min. The mobile approvals system (`/api/mobile/action`, `@/lib/approvals/store`, ApprovalStack) is a separate system, not wired to Symon.
- Cancel: `TaskCtx.cancel: AtomicBool` exists; **no remote cancel command**.
- Transport: paired mobile WS (port 3002), one master ws-token, `/api/mobile/*` middleware-gated (loopback OR Bearer). Existing conversation shapes: `/api/mobile/chat` (streaming, persisted, approvalRequired) and `/api/mobile/orchestrator/threads`.
- Brain selection is GLOBAL (`~/.o8/agent_models.json` `mac_native_action`, default `claude-sonnet-5`); no per-session override exists.

## v1 contract (phone-text-first)

Principle: the phone speaks **text** (use the phone's on-device dictation for voice input); the iMac thinks and acts; replies return as **text** (phone MAY TTS locally). Mac-side spoken replies keep working — remote mode is additive.

### Desktop owns (o8 repo)

1. **Text-in** — extend `POST /api/mobile/symon`:
   `{action:"say", text}` → eval `invoke('agent_run', {prompt:text})` → `202 {taskId}` (taskId from the spawned agent task; if the current seam can't return it synchronously, return `{accepted:true}` and the phone correlates via the event stream's next task).
2. **Response-out** — new ws-server channel `symon` [DURABLE]: relay `o8:agent-task-event` payloads (`status running|done|failed|cancelled`, `tool_call {tool}`, `result_text` on done) from the webview/Rust seam onto the mobile socket. Polling fallback: `GET /api/mobile/symon?since=<ts>` returns recent `agent_tasks` rows.
3. **Interrupt** — new Tauri cmd `agent_cancel(task_id)` (sets `TaskCtx.cancel`) + `{action:"cancel", taskId}` on the route.
4. **Confirm bridge** — when `confirm_if_needed` raises a card, ALSO insert a mobile approval (kind `symon-confirm`, carries `taskId`, tool name, summary) into the mobile approvals store; `{action:"confirm", taskId, allow:true|false}` on the route resolves via `agent_confirm`. The 2-minute auto-decline stays authoritative on the Mac; the phone card shows the countdown. Resolving on either surface dismisses both.
5. **Session status** — GET keeps returning `{status: idle|listening|working}` derived as today, plus `activeTaskId`.

### Mobile owns (o8-mobile repo)

1. Assignment/Symon tab becomes a **conversation thread** (reuse the MobileTranscript shape): composer + phone-dictation mic button; user bubbles = sent text; Symon bubbles = `result_text`; compact tool chips from `tool_calls_json` / `tool_call` events while working; status header (idle/working + elapsed).
2. Subscribe to WS channel `symon`; fall back to GET polling when the socket is down.
3. Render `symon-confirm` approvals in the existing ApprovalStack with Allow/Cancel → `{action:"confirm"...}`; show the auto-decline countdown.
4. Stop button while a task runs → `{action:"cancel"}`.
5. Keep the existing power toggle as the "voice mode on the Mac" control, visually separate from the conversation.

### Explicitly v2 (not in this ship)

- Phone-hosted S2S (gpt-realtime session on the phone) — requires remote-capable token mint (today loopback+BYOK-only) and an audio path; big lift, revisit after v1 dogfood.
- Per-session brain override (`front_brain` field on `say`) — add only if v1 latency on Opus-CLI annoys; seam is `router.rs`.
- Relaying Mac-synthesized audio to the phone.

## Open questions for the mobile team

1. Correlation: is `{accepted:true}` + next-task-on-channel good enough, or does v1 need a hard `taskId` on the 202? (Desktop can plumb the id through `spawn_agent` with a small change — say which.)
2. Thread persistence: is the conversation phone-local, or should it persist as a desktop-visible thread (orchestrator-threads style) so the iMac dock shows the same conversation?
3. Does the tab need Symon's spoken fillers ("on it…") as interim bubbles (they exist as events) or only final results?
4. Anything in the MobileTranscript shape that the `agent_tasks` row can't express? (`result_text` is plain text today — markdown OK?)

— drafted by the desktop session (canvas batch holder) for parity on the next ship; redline freely, the desktop side builds to the agreed rev.
