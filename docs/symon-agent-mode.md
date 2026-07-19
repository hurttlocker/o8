# Symon Agent Mode — phone-hosted voice, Mac-executed tools

**Status: AUTHORITATIVE CONTRACT — BUILT AND LIVE END-TO-END (2026-07-08).** Mobile leg shipped at `o8-mobile@84a975c` (TestFlight); desktop half at `8edbfe16`, shipped in o8 **v0.1.566**. This is THE phone↔Symon contract of record. Any change to an endpoint, event name, or payload shape must be flagged loudly (commit message + issue + direct note to the mobile lane), never slipped in.

Counterpart: `hurttlocker/o8-mobile` (Expo SDK 55 / RN 0.83). Desktop half lives in this repo. Supersedes `docs/phone-symon-contract.md` for the voice path — that doc is a historical proposal whose only still-live sections are the text-first say loop and the symon-confirm approval bridge (both PROPOSED, unbuilt; see its status header).

## What this is

The operator holds a full voice conversation with Symon **through the phone** — phone mic → Symon (same brain, same tool loop, same voice) → phone speaker — while every tool call still executes **in the desktop app's runtime on the Mac**. Nothing about Symon's brain, tools, or voice changes; only the audio endpoints move.

The existing phone toggle (`GET/POST /api/mobile/symon`) remains shipped and unchanged — that is **Remote mode** (starts the Mac's own mic session). This document defines the new primary **Agent mode**.

## Architecture: A — ephemeral-token WebRTC, tool relay

Chosen over WS audio relay (B) because: WebRTC gives echo cancellation + jitter buffering for free; phone↔OpenAI is often faster than phone↔Mac over Tailscale; audio never transits our transport so the Mac adds zero audio latency. B (base64 PCM16 over the `symon` WS channel, `terminal`-channel style) is the documented fallback ONLY if ephemeral tokens cannot carry our session config — implementation must prove A before falling back, and a fallback is a contract change (see change control above).

```
phone mic ──WebRTC──► OpenAI Realtime ◄──ephemeral token── Mac mints w/ full session config
phone ◄─WebRTC audio── OpenAI
phone ──data channel: tool_call──► phone forwards over WS `symon` ──► Mac executes (same runtime)
phone ◄── `symon-tool-result` over WS ◄── Mac                phone hands result back to the model
```

The phone is a **dumb pipe** for tools: it never executes anything.

## Endpoints

### POST `/api/mobile/symon/session`  (Bearer ws-token; middleware-gated like all `/api/mobile/*`)

Mints an ephemeral OpenAI Realtime client token carrying the **same session config the desk-mic session uses** — model, voice, instructions, and the full tool schema set. Config parity is a hard requirement: the implementation must assemble it from the same source the desktop realtime client uses (`src/lib/voice/realtime-client.ts` session config + the Rust-supplied tool schemas that reach the webview today), not a copy-paste snapshot.

Request body (all fields optional; legacy `{}` remains valid):
```json
{
  "workspaceMode": "code",
  "currentRoute": "/symon",
  "sourceRoute": "/chat",
  "repoPath": "/absolute/repository/path",
  "repoName": "o8-mobile",
  "branch": "main",
  "threadId": "thread-7",
  "sessionKey": "run:42",
  "threadTitle": "Voice interface work",
  "backend": "default",
  "agentId": "worker-2",
  "agentName": "Builder",
  "selectedFile": "src/app/symon.tsx",
  "controlTab": "changes",
  "runStatus": "review",
  "activeSurface": "symon"
}
```

This is bounded workspace context, not a second persona or a free-form prompt. The
server accepts only the `"o8"` and `"code"` workspace modes; route-shaped
`currentRoute` / `sourceRoute`; an absolute portable-ASCII `repoPath`; a relative
portable-ASCII `selectedFile`; bounded identifier, branch, and display-label
fields; and the frozen enum values shown above. Paths reject whitespace,
traversal, duplicate separators, control characters, and markup. Overlong,
malformed, prompt-shaped, and unknown fields are ignored. The complete request
body is capped at 4096 characters, while legacy `{}` remains valid.

Valid fields are serialized as JSON inside the frozen
`[[O8_PHONE_CONTEXT_V1_START]]` / `[[O8_PHONE_CONTEXT_V1_END]]` markers after the
existing Symon persona and phone-surface guidance. This server-authored block is
data only: it can scope tool selection and presentation, but it cannot change
Symon's identity, safety policy, or instruction hierarchy. The markers also let a
live client replace navigation context without duplicating or editing the trusted
instruction prefix.

When `workspaceMode` is `"code"`, the server additionally teaches the phone mint
the Code surface pack: `RepoState`, `ChangeSummary`, `CheckRunList`, `AgentRun`,
`DiffPreview`, `CommitSummary`, `ApprovalDecision`, `CodeAction`, and
`CodeActionRow`. Code cards may show only current tool-grounded facts and exact
tool-supplied target IDs; navigation context is a hint for which read-only lookup
to make, never evidence of repository state. Diffs stay revisioned and bounded,
and truncated results say so. The `continue-run`, `steer-run`, `approve`, and
`reject` actions always flow through the existing native confirmation step. Life
(`workspaceMode: "o8"`) keeps the generic phone vocabulary and never receives the
Code authoring instructions.

Success `200`:
```json
{
  "ok": true,
  "session": {
    "sessionId": "sym-<uuid>",
    "clientSecret": "<ephemeral token — expires in ~60s, connect promptly>",
    "expiresAt": 1783490000000,
    "model": "<same model id the desk session uses>",
    "voice": "<same voice>",
    "baseUrl": "https://api.openai.com/v1/realtime"
  },
  "preempted": "desk" | null
}
```

Side effect: if a desk-mic session is live, it is **stopped cleanly before minting** (see mutual exclusion) and `preempted: "desk"` is set.

Errors (typed, structured, never thrown):
| HTTP | body.error | meaning |
|---|---|---|
| 401 | `unauthorized` | missing/bad Bearer (middleware) |
| 403 | `locked` | entitlement does not include S2S (same rule as the desk mint) |
| 501 | `no_key` | BYOK OpenAI key absent (same rule as the desk mint — managed proxy does not carry realtime in v1) |
| 502 | `mint_failed` | upstream OpenAI session-mint failure (body includes `detail`) |
| 503 | `desktop_unavailable` | webview/eval bridge unreachable (app not running) |

### GET/POST `/api/mobile/symon` — unchanged (Remote mode)

One **additive** field on GET responses: `"agentSession": { "sessionId", "startedAt", "status" } | null`.

### POST `/api/mobile/symon/tool` — internal relay target (ws-server → Next; same gate)

Not called by the phone. Body `{ sessionId, callId, tool, args }` → executes via the eval bridge (`invoke('realtime_invoke_tool', …)` — the exact same dispatcher + SafetyClass gate the desk session's tool calls run through) → returns `{ ok, result }`. Documented so the relay is auditable; the phone-facing surface is the WS channel below.

## WS channel: `symon`  (multiplexed on the existing paired socket, port 3002 — `subscribe("symon", handler)`)

All messages are JSON with `channel: "symon"`. DURABLE semantics (queued under backpressure, like `agent-lifecycle`). No audio ever transits this channel in Architecture A.

**Wire shape (contract-critical, clarified 2026-07-10):** symon frames are **FLAT and `type`-keyed in BOTH directions** — `{ "channel": "symon", "type": "symon-…", …fields at top level }`. There is **no** `{event, data}` envelope on this channel (unlike `terminal`/`chat` server pushes). The desktop reads inbound fields off the top level (`handleSymonToolCall` et al.) and its pushers send the same way. The mobile client originally spoke `{event, data}` on this channel and NEVER matched — voice conversations masked it because audio is phone↔OpenAI direct; only tools/status ride this channel. Mobile corrected 2026-07-10 (hurttlocker/o8-mobile). Any future frame added here MUST be flat `type`-keyed.

### Phone → server

| event | payload | semantics |
|---|---|---|
| `symon-tool-call` | `{ sessionId, callId, tool, args }` | forward of a model `function_call`; `args` = parsed JSON object (not the raw string); `callId` = the model's call id, opaque to us, echoed back verbatim |
| `symon-agent-status` | `{ sessionId, status: "connecting" \| "live" \| "error" \| "idle", detail? }` | phone reports its WebRTC lifecycle so the Mac UI can show "Symon is live from the phone" |
| `symon-stop` | `{ sessionId }` | phone ended the session (user tap, app background, WebRTC close) |

### Server → phone

| event | payload | semantics |
|---|---|---|
| `symon-tool-result` | `{ sessionId, callId, ok, result }` | `result` = JSON value to hand back to the model as the function output; on failure `ok:false` and `result` = `{ "error": "<code>", "detail"?: "<human text>" }` |
| `symon-agent-status` | `{ sessionId, status: "idle" \| "connecting" \| "live" \| "acting" \| "error", detail? }` | authoritative session state; `acting` is emitted while a tool executes, then back to `live` |
| `symon-task-complete` | `{ taskId, status: "done" \| "failed", intentText, resultText, truncated }` | additive background-Claude completion; emitted after the full result is persisted in `agent_tasks`, only to active Agent-mode sessions. `resultText` is capped at 600 Unicode characters plus `…`; `truncated:true` means the phone must treat it as a spoken summary, not the complete record. |

Mobile-lane contract-change note: forward `symon-task-complete` into the live WebRTC data channel as a conversation item so the model speaks it. Preserve all fields verbatim; the full result remains Mac-local in `agent_tasks`.

### Tool relay semantics

- One tool call at a time is the normal case, but the relay MUST tolerate concurrent `symon-tool-call`s (the model can parallel-call); correlate strictly by `callId`.
- Execution timeout: **60s** per call → `{ ok:false, result: { error: "tool_timeout" } }`. The Mac-side execution is not cancelled (same behavior as desk mode); a late result is dropped.
- Tools that hit Symon's confirmation gate behave exactly as on desk: the Allow/Cancel card renders on the Mac dock with the 2-minute auto-decline. In v1 the phone is told honestly: `{ ok:false, result: { error: "needs_confirmation", detail: "Approve on the Mac dock" } }`, and a `symon-agent-status` with `detail:"awaiting Mac approval"` fires so the tab can render it. Phone-side approval is the follow-up spec'd in `docs/phone-symon-contract.md` §confirm-bridge — NOT in v1.
- Unknown/disallowed tools flow through the same dispatcher and return its error shape in `result` — the relay never invents tool semantics.

## Mutual exclusion — LAST-START-WINS (symmetric)

One operator, one Symon voice at a time:

- Starting an **Agent-mode session** (`POST /session`) while a desk-mic session is live: the desk session is stopped cleanly first (same code path as the user toggling it off), the response carries `preempted:"desk"`, and the desk UI shows a "Symon moved to your phone" notice.
- Starting a **desk-mic session** (double-tap / dock / Remote-mode toggle) while an Agent-mode session is live: the Agent session is terminated — `symon-agent-status {status:"idle", detail:"preempted_by_desk"}` is pushed to the phone, which must close its WebRTC connection on receipt.
- A second `POST /session` while an Agent session is live: last-start-wins as well (the old `sessionId` gets the same `idle`/`preempted` push) — this makes phone-app restarts self-healing.
- Rationale: the operator is one person moving between surfaces; whichever mic they pick up wins. Never two live sessions; never a refusal the operator has to untangle.

## Session registry

The desktop keeps exactly one `activeAgentSession` record `{ sessionId, startedAt, lastStatus, source: "phone" }` (server-side, process-local is acceptable in v1 — it can be re-derived from status events after a restart). It powers the GET field, the mutual-exclusion rule, and stale-session cleanup: a session with no status event or tool call for **10 minutes** is marked `idle` and dropped.

## Security

- Session mint requires the paired Bearer ws-token; the `symon` WS channel rides the already-authed socket. No new auth surface.
- The ephemeral client token is short-lived (~60s window to connect) and single-session; it is returned once and never persisted server-side.
- Tool execution runs the **same** SafetyClass gate + confirm registry as desk mode — Agent mode grants zero new capability, it only moves the microphone.
- The BYOK OpenAI key never leaves the Mac; only the ephemeral token does.
- Phone workspace context is a small typed app-state envelope, never raw prompt
  text. The mint bounds and validates every accepted field and never copies unknown
  or malformed request content into Realtime instructions.

## Mobile build checklist (from this contract)

1. `react-native-webrtc` native rebuild via EAS (SDK 55 / RN 0.83 — routine, per mobile team).
2. `POST /api/mobile/symon/session` → open WebRTC to `baseUrl` with `clientSecret` within its expiry; renegotiate = new session mint. **SDP exchange = `POST {baseUrl}/calls?model={model}`** (OpenAI GA realtime) — NOT the bare `baseUrl` (retired beta; returns 400 "Realtime Beta API is no longer supported"). Verified live 2026-07-08 (o8-mobile e8ad9bc): bare→400, GA→201. The desk-voice proxy already uses GA.
3. `subscribe("symon", …)`; forward every model `function_call` as `symon-tool-call` (parse arguments JSON before sending); hand every `symon-tool-result.result` back to the model verbatim; render `symon-agent-status`.
4. Emit `symon-agent-status` on WebRTC lifecycle transitions and `symon-stop` on teardown (including app-background if the session should not survive it — mobile's call; document in the tab).
5. Keep the existing toggle UI as secondary "Remote mode" (unchanged endpoints).
6. On `status:"idle"` push (preemption), close WebRTC immediately.

## Verification (desktop, before mobile integrates)

- curl: mint a session (expect 200 + clientSecret with BYOK key present; 501 without; 403 when locked; second mint preempts the first).
- Scripted WS client: subscribe `symon`, send `symon-agent-status connecting/live`, send a `symon-tool-call` for a real ReadOnly tool (e.g. `o8_status`) and assert a correlated `symon-tool-result` + the `acting`→`live` status pair. Evidence tail belongs in the implementation report.
