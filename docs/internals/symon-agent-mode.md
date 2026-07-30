# Symon Agent Mode — phone-hosted voice, Mac-executed tools

**Status: authoritative contract, built end to end.** Any change to an endpoint, event name, or payload shape must be coordinated with the mobile client and called out explicitly.

Counterpart: `hurttlocker/o8-mobile` (Expo SDK 55 / RN 0.83). Desktop half lives in this repo. This contract supersedes the archived phone-voice proposal; the text-first say loop and the Symon-confirm approval bridge remain proposed and unbuilt.

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

Mints an ephemeral OpenAI Realtime client token carrying the shared voice,
persona, and live Mac tool schemas used by the desk-mic session. The workspace
then selects both the phone catalog and model: ordinary Life and legacy `{}`
receive the complete live bridge catalog on mini, the repository catch-up launch
uses flagship, and Code receives the explicit bounded pack below and can
participate in the server-owned mini/flagship experiment.
Desktop mints remain unchanged. All schemas still come from the Rust-supplied
live catalog that reaches the webview; the server filters those schemas by name
rather than maintaining copy-pasted tool definitions.

Request body (all fields optional; legacy `{}` remains valid):
```json
{
  "workspaceMode": "code",
  "launchKind": "repository-catch-up",
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

`launchKind` accepts only `"repository-catch-up"`. It is a server-owned routing
discriminator for the Home briefing, not model evidence; the phone sends the
observed Git payload separately after WebRTC is live.

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

### Phone Code tool pack (v1)

Only `workspaceMode: "code"` filters Mac-executed tools. Its exact catalog is:

`o8_status`, `o8_needs_me`, `o8_review_diff`, `o8_dispatch`, `o8_delegate`,
`o8_packet_wait`, `o8_packet_steer`, `o8_agent_task`, `o8_packet_rerun`,
`o8_packet_reset`, `o8_stop_agent`, `o8_approve_item`, `o8_reject_item`,
`git_status`, `git_log`, `symon_ledger_recent`, and `symon_ledger_undo`.

The phone-local `render_surface` tool is appended after that pack and never
relayed to the Mac. Mail, media, browser, shell, file, and every other desktop or
Life tool are excluded from Code even when the live Mac catalog contains them.
The phone-minted schemas omit `repo`, `repoId`, and `repoPath` and reject unknown
arguments. Repository identity belongs exclusively to the immutable Mac grant;
the relay injects the canonical values after the model chooses a tool.
The filter preserves the live schemas and emits them in the canonical order
above. If any required Code tool is absent or is not a function schema, the mint
fails as `503 desktop_unavailable` with the missing names instead of silently
creating a partial Code agent. This strict failure applies only to Code; Life,
legacy `{}`, and desktop continue using their full catalogs.

### Spoken packet review

Packet approvals use the canonical `review-state` route through
`o8_review_diff`. The tool takes the exact `approvalId` and `packetId`, then
returns a bounded `spokenSummary`, structured evidence, and a five-minute,
single-use `reviewReceipt` bound to that approval, packet, and reviewed HEAD.
The evidence includes committed, tracked-dirty, and untracked paths, deletions,
migration/schema paths, API or command surfaces, current-HEAD AI findings,
merge-gate checks, blind second-pass status, and current-attempt test status.
Symon reads the summary and passes the receipt to `o8_approve_item` or
`o8_reject_item`; it never reads raw diff hunks aloud.

The review read and native confirmation preflight fail closed when the brief,
receipt, approval binding, or reviewed HEAD is unavailable or stale. The
confirmation card repeats the bounded summary as a visual fallback if audio is
still playing. Test status is explicitly `not-reported` unless current-attempt,
HEAD-bound evidence names an executed passing or failing command; older
evidence is `stale`. Second-pass state remains distinct as
`not-required`, `pending`, `agreed`, or `blocked` so a missing verdict is never
spoken as approval.

Success `200`:
```json
{
  "ok": true,
  "scopeVersion": 1,
  "session": {
    "sessionId": "sym-<uuid>",
    "clientSecret": "<ephemeral token — expires in ~10 minutes, connect promptly>",
    "expiresAt": 1783490000000,
    "model": "gpt-realtime-2.1-mini",
    "modelVariant": "mini",
    "billingSource": "chatgpt-subscription",
    "voice": "<same voice>",
    "baseUrl": "https://api.openai.com/v1/realtime",
    "scopeVersion": 1
  },
  "scope": {
    "version": 1,
    "repoId": "<registered repo id, or null in Life>",
    "repoPath": "/canonical/registered/path",
    "workspaceMode": "code"
  },
  "preempted": "desk" | null
}
```

Code requires an exact registered `repoPath`. The Mac resolves that path to its
canonical registry pair and persists an immutable session grant containing the
subject/device identity, workspace mode, `repoId`, `repoPath`, allowed tools,
issue time, and scope version. The phone refuses to open WebRTC unless a Code
mint returns version 1 and the exact requested path. Repo changes therefore
tear down and remint the session instead of editing instructions in place.

The mint first reads the standard Codex ChatGPT-OAuth credential and uses its
access token to request the short-lived Realtime client secret. This path is
reported as `billingSource:"chatgpt-subscription"` and does not resolve or send a
Platform API key. Ordinary sessions retain the existing BYOK fallback, reported
as `billingSource:"openai-api-key"`, for users without ChatGPT OAuth. Repository
catch-up fails closed when OAuth is unavailable so it can never spend Platform
credits.

Ordinary Life uses `gpt-realtime-2.1-mini`; repository catch-up uses
`gpt-realtime-2.1`. Code reads
`O8_SYMON_CODE_REALTIME_EXPERIMENT=mini|flagship|ab`; `ab` assigns a stable
subject-and-repo bucket. An authenticated operator-only test may override one
Code mint with `x-o8-symon-code-model: mini|flagship`. The flagship is
`gpt-realtime-2.1`; the response exposes `modelVariant` so eval reports cannot
confuse the two cohorts.

Side effect: if a desk-mic session is live, it is **stopped cleanly before minting** (see mutual exclusion) and `preempted: "desk"` is set.

Errors (typed, structured, never thrown):
| HTTP | body.error | meaning |
|---|---|---|
| 401 | `unauthorized` | missing/bad Bearer (middleware) |
| 403 | `locked` | entitlement does not include S2S (same rule as the desk mint) |
| 501 | `no_key` | BYOK OpenAI key absent (same rule as the desk mint — managed proxy does not carry realtime in v1) |
| 501 | `subscription_unavailable` | repository catch-up requires a current Codex ChatGPT-OAuth login and will not fall through to BYOK |
| 502 | `mint_failed` | upstream OpenAI session-mint failure (body includes `detail`) |
| 503 | `desktop_unavailable` | webview/eval bridge unreachable, or the live catalog is missing a required Code tool |

### GET/POST `/api/mobile/symon` — unchanged (Remote mode)

One **additive** field on GET responses: `"agentSession": { "sessionId", "startedAt", "status" } | null`.

### POST `/api/mobile/symon/tool` — internal relay target (ws-server → Next; same gate)

Not called by the phone. Body `{ sessionId, callId, tool, args, utterance? }` re-loads the
active grant, rejects disallowed tools, overwrites repo arguments with the
server-owned canonical pair, and then executes through the same Rust dispatcher
and SafetyClass gate as desk mode. A normal completion returns `{ ok, result }`;
a gated call returns `{ ok:false, result:
{error:"needs_confirmation", detail}, confirmation }` while its original webview
promise remains pending under the exact `(sessionId, callId)` key.

`dryRun:true` is an authenticated operator/eval diagnostic: it performs the same
grant validation and returns the exact scoped args without invoking Rust.

### POST `/api/mobile/symon/confirm` — internal resolver (ws-server → Next)

Body `{ sessionId, callId, confirmationId, allow, terminal? }` resolves only the matching
cached invoke through `window.__o8SymonAgent.resolveConfirm`. The response is
`{ok:true,resolution:{status:"resolved"|"already_resolved",allow}}` or a terminal
`expired`/`preempted` resolution. A mismatched triple fails closed. The route
never accepts tool arguments or repo context. `terminal` accepts only `expired`
or `preempted`, only with `allow:false`; the Rust gate records that exact reason
instead of letting the relay relabel an ordinary rejection after the fact.

## WS channel: `symon`  (multiplexed on the paired socket resolved from `O8_WS_PORT` or `~/.o8/ws-port` — `subscribe("symon", handler)`)

All messages are JSON with `channel: "symon"`. DURABLE semantics (queued under backpressure, like `agent-lifecycle`). No audio ever transits this channel in Architecture A.

**Wire shape (contract-critical, clarified 2026-07-10):** symon frames are **FLAT and `type`-keyed in BOTH directions** — `{ "channel": "symon", "type": "symon-…", …fields at top level }`. There is **no** `{event, data}` envelope on this channel (unlike `terminal`/`chat` server pushes). The desktop reads inbound fields off the top level (`handleSymonToolCall` et al.) and its pushers send the same way. The mobile client originally spoke `{event, data}` on this channel and NEVER matched — voice conversations masked it because audio is phone↔OpenAI direct; only tools/status ride this channel. Mobile corrected 2026-07-10 (hurttlocker/o8-mobile). Any future frame added here MUST be flat `type`-keyed.

### Phone → server

| event | payload | semantics |
|---|---|---|
| `symon-tool-call` | `{ sessionId, callId, tool, args, utterance?, protocolVersion?:2 }` | forward of a model `function_call` plus its item-correlated committed transcript for the durable action ledger; v2 opts into phone confirmation; omitted means fail-closed v1 |
| `symon-confirm-decision` | `{ sessionId, callId, confirmationId, allow, clientMutationId }` | v2 decision for one exact gate; no tool args or scope fields are accepted |
| `symon-agent-status` | `{ sessionId, status: "connecting" \| "live" \| "error" \| "idle", detail?, protocolVersion?:2 }` | phone reports WebRTC lifecycle and may negotiate additive v2 |
| `symon-stop` | `{ sessionId }` | phone ended the session (user tap, app background, WebRTC close) |

### Server → phone

| event | payload | semantics |
|---|---|---|
| `symon-tool-result` | `{ sessionId, callId, ok, result }` | `result` = JSON value to hand back to the model as the function output; on failure `ok:false` and `result` = `{ "error": "<code>", "detail"?: "<human text>" }` |
| `symon-confirm-required` | `{ sessionId, callId, confirmationId, taskId, tool, summary, expiresAt, target:{approvalId?,packetId?,laneId?,sessionKey?} }` | v2-only pending gate; render Allow/Cancel without completing the model function call |
| `symon-confirm-settled` | `{ sessionId, callId, confirmationId, outcome:"approved"\|"declined"\|"expired"\|"preempted"\|"duplicate", firstOutcome? }` | decision acknowledgement; duplicate replay never re-executes the tool |
| `symon-action-complete` | `{ sessionId, callId, tool, status:"accepted"\|"review"\|"done"\|"failed"\|"stopped", confirmationId?, taskId?, approvalId?, packetId?, laneId?, sessionKey?, ts }` | normalized action lifecycle emitted beside the single final tool result |
| `symon-agent-status` | `{ sessionId, status: "idle" \| "connecting" \| "live" \| "acting" \| "error", detail? }` | authoritative session state; `acting` is emitted while a tool executes, then back to `live` |
| `symon-task-complete` | `{ taskId, status: "done" \| "failed", intentText, resultText, truncated }` | additive background-Claude completion; emitted after the full result is persisted in `agent_tasks`, only to active Agent-mode sessions. `resultText` is capped at 600 Unicode characters plus `…`; `truncated:true` means the phone must treat it as a spoken summary, not the complete record. |

Mobile-lane contract-change note: forward `symon-task-complete` into the live WebRTC data channel as a conversation item so the model speaks it. Preserve all fields verbatim; the full result remains Mac-local in `agent_tasks`.

### Tool relay semantics

- Parallel calls are keyed by `(sessionId, callId)`; confirmations add
  `confirmationId`. Terminal results are cached for five minutes so duplicate
  calls replay instead of executing twice.
- Execution timeout is **60s**, paused while awaiting the Rust gate. The gate's
  `expiresAt` is authoritative and auto-denies. Stop, disconnect, stale cleanup,
  and session preemption also submit denial before dropping the call.
- v2 receives `symon-confirm-required`, sends one decision, then receives a
  settlement and exactly one final `symon-tool-result`. First decision wins;
  retries replay the original settlement/result. v1 never receives new frames:
  the server immediately denies the gate and returns only the final declined
  tool result, so an old phone cannot accidentally authorize execution.
- A Code call is authorized twice: at the authenticated WS boundary and again
  inside `/api/mobile/symon/tool`. Both use the immutable session grant. The Mac
  injects canonical `repoId` and `repoPath`; model-supplied repo names or paths
  cannot widen scope. `o8_delegate` additionally requires the exact repo pair at
  the internal orchestrator endpoint before its turn enters the repo-keyed queue.
- Unknown or disallowed tools fail as structured results. They never reach the
  dispatcher and the relay never invents tool semantics.
- `dispatch`, `steer`, `agent-task`, and `rerun` emit `accepted` immediately,
  then `review`, `done`, `failed`, or `stopped` when the matching repo/lane
  lifecycle arrives. `delegate` emits `accepted` with a stable task id and later
  `done`/`failed` from the queued orchestrator turn. `stop` emits `stopped` after
  the exact lane has been reaped and archived. The phone forwards every terminal
  update into the live Realtime conversation so Symon answers aloud.

## Durable action ledger

Every tool attempt enters `~/.o8/agent.db` before confirmation or execution.
The append-only `agent_action_events` rows preserve the spoken utterance, an
allowlisted argument summary, card identity and decision, execution phase, and
terminal outcome; inverse payloads live separately as opaque, single-use
tokens. Phone reads and undo are restricted to the immutable Realtime session
that created the action, while desktop/Life can read their local history.

`symon_ledger_recent` returns the latest durable phase for each action and an
explicit `undoable` flag. `symon_ledger_undo` accepts only an exact returned
`action_id`, always opens a fresh confirmation card, and executes the guarded
inverse once. Automatic inverses currently cover in-place text edits, text/CSV
file writes, and newly created Reminders, Calendar events, and Notes. File and
resource inverses compare the current post-state before changing it; a later
edit, symlink replacement, resource mutation, consumed token, or app restart
for an in-memory edit makes the undo fail closed.

## Mutual exclusion — LAST-START-WINS (symmetric)

One operator, one Symon voice at a time:

- Starting an **Agent-mode session** (`POST /session`) while a desk-mic session is live: the desk session is stopped cleanly first (same code path as the user toggling it off), the response carries `preempted:"desk"`, and the desk UI shows a "Symon moved to your phone" notice.
- Starting a **desk-mic session** (double-tap / dock / Remote-mode toggle) while an Agent-mode session is live: the Agent session is terminated — `symon-agent-status {status:"idle", detail:"preempted_by_desk"}` is pushed to the phone, which must close its WebRTC connection on receipt.
- A second `POST /session` while an Agent session is live: last-start-wins as well (the old `sessionId` gets the same `idle`/`preempted` push) — this makes phone-app restarts self-healing.
- Rationale: the operator is one person moving between surfaces; whichever mic they pick up wins. Never two live sessions; never a refusal the operator has to untangle.

## Session registry

The desktop keeps exactly one `activeAgentSession` record `{ sessionId, startedAt, lastStatus, source: "phone" }` plus the separately persisted immutable scope grant described above. The status record powers the GET field, mutual exclusion, and stale-session cleanup: a session with no status event or tool call for **10 minutes** is marked `idle` and dropped. Every status, tool, decision, and stop frame must match both the active session and its authenticated operator/device subject.
Stop, disconnect, stale cleanup, and desk preemption revoke the exact persisted
grant; revocation uses an atomic move-and-compare so it cannot delete a newer
last-start-wins mint.

## Security

- Session mint requires the paired Bearer ws-token; the `symon` WS channel rides the already-authed socket. No new auth surface.
- The ephemeral client token is short-lived (~60s window to connect) and single-session; it is returned once and never persisted server-side.
- Tool execution runs the **same** SafetyClass gate + confirm registry as desk mode — Agent mode grants zero new capability, it only moves the microphone.
- Confirmation never changes authorization scope. Tool arguments are scoped
  once against the immutable session grant before invocation, stored server-side,
  and reused after approval; decision frames carry no repo or argument fields.
- The BYOK OpenAI key never leaves the Mac; only the ephemeral token does.
- Phone workspace context is a small typed app-state envelope, never raw prompt
  text. The mint bounds and validates every accepted field and never copies unknown
  or malformed request content into Realtime instructions.

## Mobile build checklist (from this contract)

1. `react-native-webrtc` native rebuild via EAS (SDK 55 / RN 0.83 — routine, per mobile team).
2. `POST /api/mobile/symon/session` → open WebRTC to `baseUrl` with `clientSecret` within its expiry; renegotiate = new session mint. **SDP exchange = `POST {baseUrl}/calls?model={model}`** (OpenAI GA realtime) — NOT the bare `baseUrl` (retired beta; returns 400 "Realtime Beta API is no longer supported"). Verified live 2026-07-08 (o8-mobile e8ad9bc): bare→400, GA→201. The desk-voice proxy already uses GA.
3. `subscribe("symon", …)`; advertise `protocolVersion:2` on status/tool frames,
   render `symon-confirm-required`, and send exact decisions with a stable
   `clientMutationId`. Do not complete the model function call until the one
   final `symon-tool-result` arrives.
4. Emit `symon-agent-status` on WebRTC lifecycle transitions and `symon-stop` on teardown (including app-background if the session should not survive it — mobile's call; document in the tab). Render `symon-confirm-settled` and `symon-action-complete` as lifecycle feedback.
5. Keep the existing toggle UI as secondary "Remote mode" (unchanged endpoints).
6. On `status:"idle"` push (preemption), close WebRTC immediately.

## Verification (desktop, before mobile integrates)

- curl: mint a session (expect 200 + clientSecret with BYOK key present; 501 without; 403 when locked; second mint preempts the first).
- Scripted WS client: subscribe `symon`, send `symon-agent-status connecting/live`, send a `symon-tool-call` for a real ReadOnly tool (e.g. `o8_status`) and assert a correlated `symon-tool-result` + the `acting`→`live` status pair. Evidence tail belongs in the implementation report.

## Code intent and model eval

The mobile repo owns `scripts/symon-code-intents.json` and
`scripts/symon-code-intent-eval.mjs`. Its 15 fixtures cover the entire Code pack
as spoken request → expected tool sequence → exact raw stable-ID args → expected
native confirmation → exact server-scoped repo args → deterministic final state.
Instruction prose such as `task`, `message`, `feedback`, and `reason` may be
faithfully paraphrased; the evaluator holds tool routing, stable IDs, and repo
containment exact so it does not mislabel a wording change as a relay failure.

Run `bun run eval:symon-code:validate` for a mutation-free fixture contract
check. Run `bun run eval:symon-code -- --repo /absolute/path --models mini,flagship`
against a current desktop build for the model A/B. The evaluator never executes
mutations: it calls the real relay with `dryRun:true`, then returns fixture-owned
tool outcomes to Realtime. This isolates model/prompt selection from schema and
scope-relay failures; real backend completion for mutating tools remains a
physical-phone confirmation dogfood check.
