# Managed Live voice: draft integration and frontend handoff

## Delivery boundary

This draft implements the application relay, browser WebRTC transport, existing-chat adapter, and existing Symon text-session adapter. It requires the separate managed-gateway draft. It is **disabled by default and not production-activation ready**. No provider calls, native device tests, deployment, pricing changes, or release have been performed.

The desktop controls are a reference integration. **Native o8-mobile integration remains frontend work**: use the existing `src/features/symon/use-symon-agent.ts` / `webrtc.ts` and `src/o8/symon-text.ts` seams, replace only transport, and retain their permission UI. Do not route phone voice into a new backend/worker. This draft does not claim a completed two-device feature.

## Ownership and protocol

- The chat binding captures repository, thread, runtime and model. Voice sends through the existing governed composer send seam, with a pinned resolver and an explicit server no-fallback flag; refreshing defaults cannot reroute a live voice turn. Existing backend permissions, tools and transcript persistence remain authoritative.
- `voiceTerminal` is an additive websocket field on correlated typed terminal receipts: `{ userMessageId, outcome: completed|failed|interrupted|unconfirmed, text }`. Legacy clients ignore it. Missing fields, optimistic ready, partial text and network loss never establish completion. Stop sends the existing interrupt request. Claude/Codex local abort settlement remains unconfirmed: a done event before process termination is not stop acknowledgement. Actual successful provider-result evidence can confirm a completed turn; legacy adapters without typed evidence remain unconfirmed and hold the voice dispatch latch.
- A synchronous pending-turn latch prevents overlapping execution, including two delegations in the same poll, while the talker keeps conversing. Immediate in-flight correction is explicitly unsupported on the current adapter contract. A deliberately queued follow-up waits for the exact task terminal; see the conversational talker section below. Do not describe deferred continuation as applied steering.
- Symon uses the existing `/api/mobile/symon/text-session` and websocket text/confirmation frames, retaining the configured planner and native permission checks. Approvals use `callId`, `confirmationId`, a fresh mutation ID, and explicit user approval. Voice cannot autoapprove.
- Idle voice closure retains the backend socket and session. Managed sessions opt into authenticated same-session socket reattachment: a transport disconnect leaves existing work active, a new socket reconciles pending/terminal receipts without replay, and sessionStorage retains only the opaque identity across a page reload. Heartbeats renew the existing ten-minute session window; expired sessions fail closed. Another device/principal and a competing connected owner cannot attach. **Backend process restart with an unresolved native turn remains unconfirmed**: durable pending markers prevent a new turn until native ownership can be reconciled. This draft does not invent native replay or claim that unresolved work stopped.
- The browser receives SDP and opaque session handles, never the server OpenAI key or signed plan token. All control traffic goes through the authenticated local relay and account-bound gateway sideband. The provider data channel has no allowed control events.

## Application API for frontend clients

Authenticate with the existing operator/device Bearer token; worker/spectator/anonymous principals are rejected. Use the configured app base URL on mobile, not a hardcoded desktop port.

`GET /api/voice/live` returns `{ enabled, entitled }`. Backend CLI sign-in does not grant managed voice entitlement. Current `entitled` means a signed plan token exists, not that the hosted reservation will fit remaining allowance.

`POST /api/voice/live` accepts:

- Start: `{ action: "start", binding, context, sdp }` -> `{ id, sdp, ... }`.
- Poll: `{ action: "poll", id, binding, after: cursor }` -> ordered `{ events: [{cursor,event}], ... }`.
- Append: `{ action: "event", id, binding, event: {type,event_id,delegation_id,content} }`.
- Close: `{ action: "close", id, binding }` -> closure requested, **not closure confirmed**.

Use unique stable event IDs for retry; a conflicting reuse returns 409. An unknown/replayed foreign binding cannot attach. Poll/close remain available for owned sessions after the start feature gate is disabled. App relay ownership is currently process-local; restart/multiple replicas require durable routing before production activation.

The transport uses `gpt-live-1` via server session creation plus sideband attachment. The only valid delegation contract is `session.delegation.created` with a client target; there is no task-text property. Input transcript fragments concatenate verbatim. Unusable transcript capture asks for repetition rather than inventing a request. Appended text acknowledgement is not spoken-audio completion.

## Idle and interruption behavior

The default requests graceful close after 30 seconds without advancing recognized speech. Browser setup has a 45-second timeout; late microphone grants are stopped and a late funded session ID receives a closure request, with unknown billing retained. A one-time live-ready baseline gives the caller an initial 30-second window even after slow connection setup; provider billing still includes setup. Transcript timing uses the local start-request anchor as an approximation because Live does not expose a synchronized client/media clock. Global typing, clicks, microphone noise and backend waiting do not reset it. New nonempty input/output transcript intervals advance the speech clock by their approximate session-relative end time, not delivery time; replayed, stale, zero-duration and malformed/future fragments cannot keep voice alive. Both surfaces show an explicit **Resume voice** action after confirmed closure; there is no automatic reconnect loop.

Local microphone energy is only an uncertainty guard: after recognized input it can extend the deadline by at most five seconds. Audible output (remote energy while the audio player is not paused) has a one-second quiet tail and at most fifteen seconds of extra drain grace after recognized output. Neither raw energy nor a stuck playback sensor can renew these bounds. This is best-effort transcript corroboration, **not a semantic VAD or a noise-proof detector**. Background speech may itself be recognized. A long transcript outage can pause real speech; the paused status explicitly warns of delayed detection. Fresh partial fragments protect long utterances. The optional transport `idleTimeoutMs` is clamped to 15–60 seconds, default 30 seconds; no production configuration was changed.

All provider-billed connected time, including silence, noise, backend wait and graceful-close delay, counts toward voice usage. There are no courtesy credits or idle exclusions. `LiveSession.usage.providerConnectedSeconds` comes only from cumulative provider usage, with `providerUsageFinal` set only on terminal usage. `recognizedSpeechSecondsDiagnostic` unions approximate speech intervals across speakers for QA only; it is not a customer meter or an allowance deduction. Missing final usage stays unconfirmed. The gateway still requests closure at its wall-clock deadline and retains reservations when closure is unknown. Backend work/context survives voice idle closure; unresolved native outcomes continue to block duplicate work.

Prepare context before connecting and keep backend work independent so silent waits can close promptly. The WebRTC 15-second initialization charge is credited against duration, so speculative connections and rapid reconnect churn waste usage. Caching or compressing backend context may improve backend token cost/latency, but does not discount Live's per-minute connection charge. Live context rotation is not durable application memory; retain authoritative task state outside voice. See [official voice cost guidance](https://developers.openai.com/api/docs/guides/voice-latency-cost?api=live), [idle/resume guidance](https://developers.openai.com/api/docs/guides/live-conversations#close-idle-sessions-and-resume), and [long conversations](https://developers.openai.com/api/docs/guides/live-conversations#manage-longer-conversations).

## Configuration and safe local acceptance

1. Pull the app draft branch and the separate private gateway draft into isolated development worktrees. Install the repository's supported Node 22 dependencies and normal patch-package patches; do not start production services.
2. Run fixture tests first: `npm test -- src/lib/voice/managed-live src/app/api/voice/live src/components/desktop/thoughts/use-orchestrator-stream src/components/desktop/thoughts/chat-panel/ManagedLiveButton.test.ts`; then `npx tsc --noEmit`, test classification, scoped lint and rule-check. Gateway: `npm test -- --run tests/live-session.test.ts` and `npx tsc --noEmit`.
3. Keep `O8_MANAGED_LIVE_ENABLED` unset for normal development. The app uses its existing signed plan token and `O8_PROXY_URL` for the isolated development gateway. The gateway uses its existing server-side OpenAI credential and entitlement/budget machinery; never paste those credentials into frontend config.
4. Gateway activation additionally requires `O8_LIVE_EXPIRY_ACCEPTED=1`. **Do not set this merely to get past the gate.** See the private gateway activation checklist: provider-enforced WebRTC expiry/crash closure, provider closure after recovery, durable event/cursor routing across replicas and a defensible reservation must be resolved. The gateway now has fenced database leases and bounded closure-only recovery; that is not a provider expiry guarantee. A close request/timer is not a hard billing ceiling.
5. Current gateway reservation is $6 (7,200 seconds at $0.05/minute). It exceeds ordinary existing paid-plan allowances; normal subscribers cannot start. Do not raise allowance, invent entitlement or silently bill a fallback to make the demo work. Fixtures inject an explicit synthetic $10 cap; they do not alter plan policy. Product price/included-minute ideas require a separate approved billing change.
6. Once the operator explicitly enables a funded local acceptance configuration, test exact selected runtime/model, phone and desktop microphone/audio, approvals/denials/expiry, two immediate delegations, stop acknowledgement, busy correction notice, cancel during each startup await, idle close, late final usage, resume without backend replacement, and disconnect failure. Inspect provider receipts and usage reconciliation. These live/device checks are unrun here and belong to the local owner.

## Brain follow-up specification (documentation only)

Coordinate with connected-routing PR #3868 and additional adapter issue #3866; this draft changes no Brain routing. Preserve explicit overrides. Filter eligible backends by isolated reasoning capability, working authentication/health, permitted payer and available model, then rank deduplicated successful user activity in a documented window, excluding Brain's own traffic. Use latest success and a stable tie-breaker; partial history is unknown, not zero. Managed reasoning is permitted only when no eligible CLI exists; a started CLI failure is visible and never silently falls back to paid inference. Retrieval, citations, indexing, embeddings and background policy stay separate.

Catalogue presence does not prove account entitlement or strongest-model access. Grok's key/config presence does not prove a subscription. DeepSeekHarness/OpenRouter routes are API-metered and need isolated adapters. OpenCode's `opencode/deepseek-v4-flash-free` is a carrier identity, not an OpenRouter model ID. 3code must intersect configured provider/model with validated availability rather than invent a default. Test winners/ties/missing history, explicit pins, absent versus expired auth, payer/model caps, cancellation, isolation, concurrent cache identity and receipts. The local frontend/backend agent owns this follow-up implementation.

## Official references verified for this draft

- https://developers.openai.com/api/docs/models/gpt-live-1
- https://developers.openai.com/api/docs/guides/live-delegation
- https://developers.openai.com/api/docs/guides/live-conversations
- https://developers.openai.com/api/docs/guides/voice-latency-cost?api=live
- https://developers.openai.com/api/docs/guides/voice-webrtc
- https://developers.openai.com/api/docs/guides/voice-server-controls

Pricing verified as $0.05/minute, billed per second, with separate backend model/tool costs. The official material inspected did not establish a configurable hard maximum for WebRTC or a reliable post-crash REST recovery path; SIP's two-hour limit is not evidence of a WebRTC ceiling.

## Conversational talker while the backend works

GPT-Live keeps its own full-duplex conversation while the bound orchestrator or Symon task runs. Delegation does not block the transport poll loop. The browser coalesces changed application context at most once per second into quiet `session.thinking.append` updates; only visible transcript/progress facts are included, not private reasoning or tool payloads. Terminal results use `session.commentary.append`. Provider append submission/acknowledgment is not proof of task execution, correction application or completed playback.

The active talker attachment receives backend updates with `delegation_id: null` for general same-conversation context. A task started in voice session A can finish while session B is attached without sending A's delegation ID to B. Closing voice detaches the talker only. Context comes from the existing conversation again on Resume; there is no second worker or parallel authority.

Current built-in orchestrator and Symon text adapters do not expose a non-interrupting in-flight steering contract. Their ordinary send path must not be used to fake one: it can preempt work. An ordinary correction therefore reports **unsupported immediate steering**, leaves the current task alone, and keeps conversation open. Obvious withdrawal, conditional or example wording requests clarification without scheduling anything. Only explicit phrases such as **queue check the tests** or **after this task check the tests** consent to a later continuation. This bounded slice holds one follow-up tied to the exact task ID; **cancel queued** removes it without interrupting the worker. A confirmed terminal is required before submission. Unconfirmed outcomes retain the guard. The orchestrator additionally rejects a stale target if another user task replaced it. Receipts distinguish locally queued, submitted, confirmed terminal and unsupported; nothing claims the correction was applied mid-task.

The queued request survives voice-only close/Resume while its original conversation component/session remains alive. It is not a durable cross-reload queue. Binding changes/unmount clear the orchestrator queue rather than retargeting it. Native steering capabilities on other runtime adapters are not silently assumed for these orchestrator paths. No dictation, Brain routing, trial or pricing behavior changes in this slice.

Official contract: [client delegation and progress](https://developers.openai.com/api/docs/guides/live-delegation).
