# Managed Live voice: integration and installed-pilot handoff

## Delivery boundary

The merged application implements the relay, browser WebRTC transport, existing-chat adapter, and existing Symon text-session adapter. General managed admission requires the separate managed-gateway draft. It is **disabled by default and not production-activation ready**. Production remains disabled. A separately authorized, expiring personal experiment can use a local relay and the operator’s existing API credential without changing managed customer admission. Development uses a private marker; an installed desktop requires an independently signed account-and-installation-bound pilot grant. Provider receipts from that experiment are distinct from production readiness and physical-shortcut acceptance.

Desktop entry uses a compact experimental waveform control in the active orchestrator composer footer and a Caps Lock tap toggle. A passive desktop overlay displays the owning chat, connection state, measured audio level and provider-reported usage. Closing voice leaves backend work running. Changing focus never retargets a connected session. A personal development check established native microphone capture, bidirectional WebRTC packets and provider-confirmed closure. Human speech, audible response and physical-shortcut acceptance remain separate checks. **Native o8-mobile integration remains frontend work**: use the existing `src/features/symon/use-symon-agent.ts` / `webrtc.ts` and `src/o8/symon-text.ts` seams, replace only transport, and retain their permission UI. Do not route phone voice into a new backend/worker. This draft does not claim a completed two-device feature.

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

Use unique stable event IDs for retry; a conflicting reuse returns 409. An unknown/replayed foreign binding cannot attach. Poll/close remain available for owned sessions after the start feature gate is disabled. Acknowledged app sessions retain private immutable ownership and pinned-gateway records across restart. Healthy-owner gateway event routing across replicas and the crash gap before provider identity publication remain unresolved; see Application relay restart ownership below.

The transport uses `gpt-live-1` via server session creation plus sideband attachment. The only valid delegation contract is `session.delegation.created` with a client target; there is no task-text property. Input transcript fragments concatenate verbatim. Unusable transcript capture asks for repetition rather than inventing a request. Appended text acknowledgement is not spoken-audio completion.

## Idle and interruption behavior

The default requests graceful close after 30 seconds without advancing recognized speech. Browser setup has a 45-second timeout; late microphone grants are stopped and a late funded session ID receives a closure request, with unknown billing retained. A one-time live-ready baseline gives the caller an initial 30-second window even after slow connection setup; provider billing still includes setup. Transcript timing uses the local start-request anchor as an approximation because Live does not expose a synchronized client/media clock. Global typing, clicks, microphone noise and backend waiting do not reset it. New nonempty input/output transcript intervals advance the speech clock by their approximate session-relative end time, not delivery time; replayed, stale, zero-duration and malformed/future fragments cannot keep voice alive. Both surfaces offer explicit resume after confirmed closure. An already-connected session may automatically reconnect once in the same chat after a provider-confirmed connection loss with valid final cumulative usage. A local RTC failure may request closure first and then use its confirmed close receipt. Stop, inactivity, expiry, safety closure, startup failure and uncertain closure never trigger an automatic restart. The handoff retains audio ownership, supports cancellation during reconnection and does not replay delegated work; a second loss stays paused.

Local microphone energy is only an uncertainty guard: after recognized input it can extend the deadline by at most five seconds. Audible output (remote energy while the audio player is not paused) has a one-second quiet tail and at most fifteen seconds of extra drain grace after recognized output. Neither raw energy nor a stuck playback sensor can renew these bounds. This is best-effort transcript corroboration, **not a semantic VAD or a noise-proof detector**. Background speech may itself be recognized. A long transcript outage can pause real speech; the paused status explicitly warns of delayed detection. Fresh partial fragments protect long utterances. The optional transport `idleTimeoutMs` is clamped to 15–60 seconds, default 30 seconds; no production configuration was changed.

All provider-billed connected time, including silence, noise, backend wait and graceful-close delay, counts toward voice usage. There are no courtesy credits or idle exclusions. `LiveSession.usage.providerConnectedSeconds` comes only from cumulative provider usage, with `providerUsageFinal` set only on terminal usage. Usage describes the current provider session and resets for a replacement; previous final accounting remains in the managed gateway journal or the separate personal test relay, not the application ownership record. `recognizedSpeechSecondsDiagnostic` unions approximate speech intervals across speakers for QA only; it is not a customer meter or an allowance deduction. Missing final usage stays unconfirmed. The gateway still requests closure at its wall-clock deadline and retains reservations when closure is unknown. Backend work/context survives voice idle closure; unresolved native outcomes continue to block duplicate work.

Prepare context before connecting and keep backend work independent so silent waits can close promptly. The WebRTC 15-second initialization charge is credited against duration, so speculative connections and rapid reconnect churn waste usage. Caching or compressing backend context may improve backend token cost/latency, but does not discount Live's per-minute connection charge. Live context rotation is not durable application memory; retain authoritative task state outside voice. See [official voice cost guidance](https://developers.openai.com/api/docs/guides/voice-latency-cost?api=live), [idle/resume guidance](https://developers.openai.com/api/docs/guides/live-conversations#close-idle-sessions-and-resume), and [long conversations](https://developers.openai.com/api/docs/guides/live-conversations#manage-longer-conversations).

## Configuration and safe local acceptance

1. Pull the app draft branch and the separate private gateway draft into isolated development worktrees. Install the repository's supported Node 22 dependencies and normal patch-package patches; do not start production services.
2. Run fixture tests first: `npm test -- src/lib/voice/managed-live src/app/api/voice/live src/components/desktop/thoughts/use-orchestrator-stream src/components/desktop/thoughts/chat-panel/ManagedLiveButton.test.ts`; then `npx tsc --noEmit`, test classification, scoped lint and rule-check. Gateway: `npm test -- --run tests/live-session.test.ts` and `npx tsc --noEmit`.
3. Keep `O8_MANAGED_LIVE_ENABLED` unset for normal development. The app uses its existing signed plan token and `O8_PROXY_URL`; that override is shared with other managed features, so do not retarget a shared Dev instance for a voice fixture. Use an isolated process/profile and synthetic dependencies for no-cost tests. The gateway's existing server-side credential must never enter frontend config.
4. **Production admission is held before any reservation or provider creation.** With rollout enabled, a server key and a valid paid entitlement, the gateway's default lifetime policy still returns no verified ceiling and responds with HTTP 503 `voice_lifetime_unverified`. The obsolete `O8_LIVE_EXPIRY_ACCEPTED` flag is ignored, including when set to `1`. The app forwards that refusal without retrying, switching providers or registering an owned session. `GET /api/voice/live` capability flags are not admission or provider acceptance.
5. There is no current production $6 / 7,200-second reservation policy. That unverified placeholder was removed. Synthetic ceilings and caps in gateway fixtures exist only to exercise reservation, fencing and settlement paths; they are not provider guarantees. Unresolved reservations continue to count toward both spend and concurrency, including after age and cap-window rollover. Do not raise budgets, restore the placeholder or add an override to enable a demo.
6. Activation requires a reviewed, provider-backed lifetime/recovery implementation, completed application/gateway routing, and explicit approval for a bounded funded test. Only then test exact selected runtime/model, phone and desktop microphone/audio, approvals/denials/expiry, two immediate delegations, stop acknowledgement, busy correction notice, cancel during each startup await, idle close, late final usage, resume without backend replacement, and disconnect failure. Inspect provider receipts and usage reconciliation. Source fixtures do not establish real microphone, speaker, shortcut or provider acceptance.

### Provider evidence required before activation

- A provider-enforced upper bound known **before WebRTC creation**, covering all billable initialization, connected and finalization time even when the app, gateway or sideband dies. A local close timer, post-creation expiry value or SIP-only limit is insufficient. Derive a reservation from that bound within unchanged remaining allowance.
- An authoritative way to resolve an uncertain creation outcome, including a lost HTTP response or a crash before the provider ID is durably journaled. Define request correlation/idempotency or retrieval semantics and which, if any, failures prove that no billable session existed. Until then, ambiguous HTTP errors retain the reservation.
- Authoritative terminal status and cumulative billed duration keyed to the provider identity, recoverable after disconnect/restart. Document retention, replay/retrieval, duplicate ordering and closure semantics. A sideband attach or close acknowledgement alone does not recover a missed terminal event; missing final usage remains unknown.
- After approval, provider receipts for the crash/recovery matrix above, including loss before identity persistence and before terminal persistence. Offline tests of closure-only recovery and durable settlement are separate evidence. Healthy-owner gateway event routing and provider/device acceptance remain separate work. Acknowledged app-relay restart ownership is implemented below; it does not resolve uncertain provider creation.

The companion gateway handoff owns its detailed safety checklist. Its admission regression uses the production defaults with the obsolete flag absent, `0` and `1`, verifies no provider HTTP/socket calls, and checks that the real disposable ledger and session journal stay empty. This application regression checks the returned hold through `/api/voice/live`. Neither fixture enables paid voice or changes the shared durable composer queue.

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

The orchestrator restores bounded earlier voice history before each connection, including the one permitted automatic reconnect. New live captions never change that application snapshot: GPT-Live already hears the exchange, and feeding its replies back as fresh facts can cause repetition. CLI progress and correlated outcomes still update. Historical requests are not pending work; a new request addressed to the coding agent, including a read-only answer, must use client delegation and await its new receipt. Startup rechecks availability before microphone capture so an expired development window reports a retryable admission failure instead of an ambiguous provider-start failure.

The active talker attachment receives backend updates with `delegation_id: null` for general same-conversation context. A task started in voice session A can finish while session B is attached without sending A's delegation ID to B. Closing voice detaches the talker only. Context comes from the existing conversation again on Resume; there is no second worker or parallel authority.

Current built-in orchestrator and Symon text adapters do not expose a non-interrupting in-flight steering contract. Their ordinary send path must not be used to fake one: it can preempt work. An ordinary correction therefore reports **unsupported immediate steering**, leaves the current task alone, and keeps conversation open. Obvious withdrawal, conditional or example wording requests clarification without scheduling anything. Only explicit phrases such as **queue check the tests** or **after this task check the tests** consent to a later continuation. This bounded slice holds one follow-up tied to the exact task ID; **cancel queued** removes it without interrupting the worker. A confirmed terminal is required before submission. Unconfirmed outcomes retain the guard. The orchestrator additionally rejects a stale target if another user task replaced it. Receipts distinguish locally queued, submitted, confirmed terminal and unsupported; nothing claims the correction was applied mid-task.

Orchestrator follow-ups use the shared persisted composer queue and its existing disclosure. The saved payload captures `afterTaskId` and `pinBackend`; admission rechecks the exact original task, runtime/model, repository, project and permissions. Persistent leads resolve optimistic chat IDs through their saved admission key. Changed or unknown task outcomes hold the item without replay. Queue withdrawal waits for earlier saves, including lost responses, then removes the original chat’s durable rows. Navigation and voice close preserve the saved request without retargeting it. Standalone Symon retains its separate session-scoped follow-up behavior; it does not borrow the parent composer queue. Native steering capabilities on other runtime adapters are not silently assumed for these orchestrator paths. No dictation, Brain routing, trial or pricing behavior changes in this slice.

Official contract: [client delegation and progress](https://developers.openai.com/api/docs/guides/live-delegation).


## Active-chat integration checkpoint

The current integration incorporates the shared worker disclosure and parent queue. It adds persisted terminal receipts, active-chat shortcut ownership shared with standalone managed voice, and a presentation-only native satellite. The satellite has event-listening capabilities only; it cannot acquire audio, dispatch tasks or invoke application controls. Main-window navigation invalidates its publisher epoch. Quiet mode cannot restore a completed voice presentation.

Source fixtures cover delayed queue cancellation, lost save responses, navigation, exact persistent-lead task aliases and stale-task rejection. Native IPC fixtures cover caller rejection, quiet restoration and reload fencing using the mock runtime. These are separate from macOS window geometry, microphone/speaker acceptance and provider lifecycle proof. Keep activation disabled until the gateway holds above and a bounded, explicitly authorized live test are resolved.


## Local development microphone preview

A development profile may opt into an expiring local microphone preview by placing
`managed-voice-preview.json` in its existing data directory, with file mode `0600`:
`{"version":1,"expiresAt":<Unix milliseconds, at most 24 hours ahead>}`. This is
recognized only by a development server. An invalid or expired marker refuses
voice requests instead of falling through to the managed provider. Remove the
marker to end the preview; this does not enable managed voice. Keep the normal
managed-voice activation flag off.

The existing chat button and Caps Lock target the selected chat. The preview
captures local microphone levels and exercises the existing presentation,
ownership, inactivity and close paths. It does not connect to a provider,
transcribe, synthesize speech, submit backend work, reserve allowance or spend.
The button and live status identify it as a local preview. These checks do not
establish microphone permission, physical hotkey, native geometry or provider
acceptance until each is actually observed on the target device. Shared queue
behavior is verified separately through its existing persisted-state tests.

## Application relay restart ownership

Acknowledged managed sessions retain immutable private ownership records in the
profile's `managed-voice-relay` directory. Version 2 records contain a hashed
principal, verified account and sign-in epoch scope, hashed conversation binding, session id and the exact
server-configured gateway. Controls survive an application-server restart and
never follow a later gateway configuration change or an HTTP redirect. Account
admission fences token capture and publication; blocked or changed account state
cannot admit a new session. Routine same-account license and managed credential
refreshes may rotate the account journal generation without revoking an owned
session. Each request still verifies the current license, account readiness and
in-flight generation. Sign-out, a fresh sign-in, a different account or principal
cannot acquire old controls. Version 1 records remain retained but are not
migrated or admitted as version 2 ownership. Records contain no bearer token,
SDP or transcript. A regression through the entitlement sync route, real account
journal, principal resolution and cold-reloaded voice route covers this boundary.

Conflicting or corrupt records fail closed and are retained. If publication
definitively created a new record but its durability cannot be confirmed, the
relay attempts closure at that pinned gateway and still reports an unknown
outcome. An uncertain create before publication remains a recovery blocker;
these records do not close the provider identity crash gap or supply healthy
cross-replica conversation routing. Production lifetime admission remains held.

## Native development preview receipt

The local preview exercised real microphone capture and measured levels reaching the native presentation, explicit disconnect, resume and idle closure. The native shortcut event path started and stopped the pinned chat; this was an injected native event, not a physical Caps Lock test. Captured audio tracks ended on close and the other four composer dictation buttons stayed idle. Native display bounds placed the presentation across the owning display’s bottom edge. No audio was stored and no provider was contacted. Screenshot capture was unavailable because the private development wrapper lacked Screen Recording permission; visual polish remains an operator check.


## Installed personal pilot admission

Installed desktop builds remain unavailable without a private `managed-voice-pilot.jwt`
in the application profile. The application verifies this grant against a dedicated
pinned public key; the signer is never bundled or accepted from an environment
override. Grants identify one verified license subject, the exact loopback relay
origin, the real profile path and sign-in epoch, and an explicit experiment purpose,
issuer and audience. Their lifetime cannot exceed 24 hours. No subscription tier,
operator number, unsigned configuration or development license key override grants
installed pilot access. Missing grants leave managed service disabled; invalid grants
refuse admission and never fall back to it.

Readiness and start share the same strict license and grant checks. Only the local
operator can start. The existing account journal, generation fence and immutable
chat binding remain authoritative. Fresh sign-in, account change or another profile
requires a newly issued grant. Ordinary same-account credential rotation retains
owned controls. Work-producing events require the same current grant and relay;
authenticated polling and closure use the original persisted ownership after grant
expiry or removal. A new grant does not take ownership of an earlier session.

The private relay independently verifies the production license signature and
expiry and repeats account/grant validation after reading the request body. It
admits one session and refuses further admission while any terminal outcome is
unresolved. An exclusive local relay lock must cover receipt reconciliation and
startup; never launch a Dev and installed relay concurrently. The old Dev relay must
be stopped and its receipts checked before switching profiles. The pilot retains
the existing best-effort close request, private terminal receipts and bounded retry.
It does not establish a provider lifetime ceiling, silently renew, change budgets,
or relax the managed gateway's `voice_lifetime_unverified` hold.

The installed admission tests call actual GET/POST handlers with persisted account
and ownership state and an HTTP relay fixture. Cryptographic fixture keys replace
only the trust roots. Rejections cover other accounts/principals, forged or expired
licenses and grants, a development key override, wrong origin/profile/epoch, sign-out,
and ownership changes during a response. Private relay HTTP checks additionally cover
slow request bodies, concurrent starts, unknown provider creation, lock exclusivity,
and restart with an unresolved receipt. These checks make no paid provider calls and
do not establish installed microphone or conversational acceptance.

## Personal development provider experiment

A development server may read a private regular `managed-voice-personal.json` file
in its existing profile, mode `0600`, containing
`{"version":1,"gateway":"http://127.0.0.1:<local-relay-port>","expiresAt":<Unix milliseconds>}`.
The expiry must be in the future and within 24 hours. Only the loopback HTTP
origin is accepted; credentials, non-root paths, query strings, symlinks and
world-readable files are rejected. Production ignores this marker entirely.
This path is operator-only and does not enable mobile or worker admission.

The operator-provided local relay must authenticate the current signed account
credential, retain the existing session identity and binding contract, and own
its provider lifecycle. The browser still receives only SDP and an opaque handle.
The application retains immutable principal/account ownership and the pinned
relay origin; known sessions can close after the marker expires. A test marker
does not grant unlimited API use, establish a provider lifetime ceiling, or
release an unresolved managed reservation. Paid testing requires operator scope.

The private experiment uses one session at a time, a best-effort local close
request and durable lifecycle receipts. The browser permits at most one automatic replacement after confirmed connection loss; the relay still admits only one active or unresolved session at a time. An uncertain
close blocks another experiment until reconciled. A local timer is not a
provider-enforced lifetime guarantee. The managed gateway’s production
`voice_lifetime_unverified` hold remains unchanged.

On 2026-10-19 UTC, the personal native check opened a real WebRTC connection,
observed outgoing microphone RTP and incoming audio RTP, then received
`session.closed` with `close_requested` and 16 final seconds. This establishes
the connection and close path, not recognized human speech or audible playback.
A separate generated-speech fixture passed the complete native path: provider
input transcript, client delegation, the existing selected CLI chat, its persisted
`gpt-6.1-sol` assistant reply, then provider output transcript and nonzero remote
audio energy. The provider confirmed 53 final seconds on close. This fixture
was synthetic; human microphone, subjective speaker quality and physical
Caps Lock acceptance are still separate checks. Delegated speech appears as the
regular chat request and result. Continuous input and output captions now use
the existing chat bubbles and history store. Spoken replies are labeled Voice
reply and do not supply CLI completion receipts. An exact send link suppresses
the delegated caption only once its ordinary CLI request exists; stored speech
evidence remains available. Caption revisions survive stale history writes and
same-thread refreshes. Pauses group display text only and never trigger work.

The browser remains Connecting until the WebRTC peer actually connects. Failed
setup with a known session still polls for final closure and usage; missing
confirmation remains Unknown. Neither change relaxes production admission.

A subsequent native generated-speech check observed captions growing from their
first fragment, persisted both speakers through the normal history endpoint, and
restored them after reload. A fresh client delegation produced exactly one
ordinary CLI request, a correlated completed CLI reply, and a separate spoken
reply. Only fragments covered by the delegation offset were linked; later speech
remained visible. These are synthetic transport and persistence receipts, not
human acoustic acceptance.

A later operator microphone test produced recognized human input and provider
reply transcripts, with confirmed final usage on closure. Its conversational
questions did not produce a client delegation or a new CLI turn; spoken claims
about connection are not backend acceptance evidence. The test exposed a context
bug: recent voice captions could replace all CLI messages in the supplied excerpt.
Voice context now reserves separate bounded sections for the existing CLI
discussion and recent speech, retaining correlated outcome qualifiers. A component
entry-point regression covers caption-heavy transcripts, subsequent ordinary chat
updates and the transport context limit. Audible playback and a fresh human-spoken
task through the CLI still require separate acceptance.

## Confirmed-loss reconnect verification

Transport fixtures exercise a one-attempt retry, unchanged chat binding, pending CLI work and delivery of its late result through the current voice subscription. They also exercise cancellation before admission and during microphone permission, manual Stop winning over a connection-loss reason, RTC failure waiting for final usage, and no retry after unknown or invalid final usage, expiry or content closure. An old voice activation cannot dispatch into a later activation of the same chat. These source checks do not simulate a provider guarantee or establish human acoustic acceptance.

After a transient poll or close failure, local capture stops immediately. For a
known owned session the client makes a bounded closure-only recovery attempt:
one close request and at most eight polls within fifteen seconds. It uses the
original conversation binding and current account authority; authorization
refusals stop recovery. Only valid final cumulative usage can reconcile Unknown
to Closed. Recovery cannot emit captions, dispatch tasks, reacquire audio or
automatically reconnect. Missing receipts remain unknown in the chat.

The desktop satellite dismisses when capture becomes Unknown or its owning chat
unmounts, including while closure is pending. Dismissal is presentation only and
does not assert provider closure or release uncertain accounting. The native
owner and epoch checks also prevent an old chat from hiding a newer display.

## Transcript continuity polish

Caption updates previously scheduled an unconditional smooth scroll to the bottom,
including after a reader scrolled into history. The transcript now follows content
only while attached to the bottom. Upward scrolling cancels pending follow work;
returning to the bottom resumes it. Bubble and viewport resize observation covers
text reveal and content growth even when the inner flex box stays viewport-sized.
History backfill retains its existing compensation, and changing the chat resets
following. Bubble styling, caption identity, execution routing and voice policy are
unchanged by this correction.

A bounded native generated-speech capture observed a 650-pixel forced scroll with
unchanged content height, one client delegation, one ordinary CLI request and a
correlated completed result matching the spoken answer. It closed with final usage.
A deterministic replay of its 55 caption events through the native bubble renderer
measured 931 pixels of reading-anchor displacement before the correction and zero
afterward, including 281 pixels of content growth. Returning to the bottom resumed
following. Caption nodes retained identity and repeated events added no duplicate
rows. This is DOM trace evidence, not a screen recording or human acoustic test.

The capture did not sample the exact instant of CLI terminal completion, so it
cannot establish completion-to-speech latency. Historical work folding also changed
layout during the real delegation; the caption replay does not establish stable
anchors through every folded-history transition. Natural first-person phrasing
still needs listening: the captured reply used third-person handoff language in
response to a prompt explicitly asking it to contact the coding agent. Successful
result correlation does not by itself prove conversational quality. Production
activation holds and uncertain-usage accounting remain unchanged.


## Restricted installed-pilot release checkpoint

The application source in #3887 is merged. General managed voice admission remains
held; the installed experiment requires the separately signed, expiring grant
specified above. Publishing an installer does not activate voice for other accounts
or complete conversational acceptance. The companion gateway draft and its provider
lifetime/recovery requirements remain separate.

The combined release candidate passed TypeScript, test classification and the full
hermetic suite (7,395 passed, four existing skips), with unchanged source hashes.
One hundred focused cases covered the combined voice, dictation, queued-send and
message-recovery paths. The Browser fixture's 29 controlled cases also passed.
Those checks prove source behavior, not microphone, speaker or installed-device
acceptance. Keep the original failed fixture runs alongside their corrections.

After installing the signed release, record the exact version and source commit,
then finish this bounded conversation checklist:

- [ ] Physical Caps Lock and the composer control start and stop voice in the
  intended chat; unrelated composers remain idle.
- [ ] Partial and final speech retain stable bubble identity and ordering. Reading
  older messages holds scroll position; returning to the bottom resumes following.
- [ ] One bounded spoken task produces one correlated CLI request and completion.
  Capture the completion timestamp and the subsequent spoken result.
- [ ] Spoken progress uses first person and reports only receipt-backed facts across
  pending, working, completed, failed and cancelled states.
- [ ] Closing the chat or voice releases the microphone and desktop overlay without
  cancelling authorized CLI work or retargeting another chat.
- [ ] One retry follows confirmed closure only. Startup cancellation, uncertain
  closure and expiry do not create duplicate work or admit another session.
- [ ] Restart preserves transcript identity and account ownership. A missing,
  invalid, expired or different-account pilot grant refuses admission.
- [ ] Provider closure and final usage reconcile; unknown outcomes remain held.

The existing [installed acceptance checklist](https://github.com/hurttlocker/o8/issues/4005#issuecomment-6280546703)
retains the handoff. Keep installed observations, generated-speech traces and human
conversation judgments distinct. Actual provider image interpretation remains
outside this voice checkpoint and open in #2637.
