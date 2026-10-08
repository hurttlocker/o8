# Connection, identity and plan-use boundaries

This is the account and consent design for
[#3248](https://github.com/hurttlocker/o8/issues/3248), and implementation input to
[#2951](https://github.com/hurttlocker/o8/issues/2951). It does not activate Sign
in with ChatGPT or broaden the hosted plugin grant. Source and official guidance
were checked October 6, 2026. The desktop plan connection is prepared separately
in [PR #3304](https://github.com/hurttlocker/o8/pull/3304). That draft connects an
existing signed-in o8 account to a ChatGPT plan; it does not replace o8 account
sign-in. Its source tests do not establish installed acceptance or qualification.

## Credentials and recipients

| Purpose | Direction and issuer | Recipient and permission | Storage and lifecycle | Current proof |
| --- | --- | --- | --- | --- |
| Desktop account session | Existing o8 account provider authenticates the desktop user | o8's ordinary signed-in account session | Provider-managed session and sign-out | Installed sign-in exists; this is not OpenAI plan-use consent |
| Desktop device renewal | o8 backend issues a revocable grant bound to the existing user and installation | Renewal endpoint exchanges it for a one-time account sign-in ticket | Current source uses atomic owner-only private files for the device grant and pending revocation intent; backend rotation and revocation are separate from plugin OAuth | Source #3217 exists; automatic renewal through natural account-session expiry is not proven by plugin reads |
| Hosted plugin OAuth | Existing o8 account provider issues an opaque OAuth grant after official ChatGPT/Codex client consent | Hosted relay, exact resource audience and permitted official client; o8:read and separately o8:follow-up | Official client owns access/refresh storage; issuer revocation must invalidate the grant | Existing consent, protected reads and one scoped continuation passed; natural refresh, live read-only scope and issuer revocation remain unproven |
| Local plugin capability | Connected desktop mints a capability for a verified relay plugin stream | Local plugin route only; machine, client and permitted scopes, one-minute maximum | Private signing material and short expiry; account OAuth tokens are not forwarded to the desktop | Persisted real-route tests and installed report read passed; this is not an operator credential or plan-use token |
| OpenAI identity sign-in | OpenAI identity grant authenticates an account to o8 | Registered identity client, validated ID token and identity-only scopes | Proposed validated account mapping; never use identity credentials as inference or plugin credentials | Replacement account sign-in is not implemented; PR #3304 validates identity only while connecting an existing o8 account to a plan |
| OpenAI plan inference | Separate OpenAI plan-use grant authorizes eligible requests | Authorized app/model inference recipient, selected user/workspace/client/host and app caps | PR #3304 prepares macOS Keychain storage, serialized rotating refresh, local disconnect and separately reported issuer revocation | Source entry-point, persisted approval, UI and stream fixtures passed; qualification and installed consent/inference/lifecycle acceptance remain open |

Identity scopes support login and consented profile information. They do not
replace the relay's task scopes. Refresh permission is separate from permission
to follow up a task. Request only the identity fields and capabilities needed for
the selected purpose, with the provider's supported registered client flow.

The current device-renewal file store describes existing source. It is not the
proposed storage model for OpenAI plan credentials. The desktop renewal remedy
and official clients' hosted OAuth refresh solve different expiration problems.

## Eligibility decision

[OpenAI's website sign-in guide](https://developers.openai.com/siwc/website)
currently describes a limited trial for selected commercial partners. Identity
sign-in needs a usable registered client and registered callbacks. A plugin
listing or publisher verification does not establish this approval.

The [open-source/local plan-use path](https://developers.openai.com/siwc/token-sharing-open-source)
is distinct from paid or remotely hosted inference. That guidance directs paid
or remotely hosted apps to an interest form. Qualification for o8's intended
distribution remains unresolved under #2951. Do not relabel a hosted relay as a
local inference host to bypass qualification. The current relay handles
deterministic tools rather than app plan inference.

A host identifier is a stable opaque installation identifier, not authentication
or proof of a person. Reuse it across restarts. Bind each OpenAI client
registration to its selected user/workspace. An account switch must not reuse
another account's client, cached model availability, quota or grant.

## Linking existing accounts

1. Begin explicit linking from a recently authenticated o8 account. Record the
   intended account, flow purpose and fresh state/nonce/PKCE in the pending
   operation.
2. Validate the authorization response and ID token: trusted issuer and
   signature, intended client audience, nonce, time bounds and stable subject.
   Use the supported provider flow for the relevant identity or local plan-use
   route. A raw API token is not proof of identity.
3. Associate the existing authoritative o8 account with issuer plus stable
   subject. Retain the validated client ID with its registration and selected
   workspace/account context for plan credentials. Confirm a returning identity
   matches the selected account before replacing that registration's tokens.
   Email is display information and an account hint; equality alone must not
   merge users, machines or grants.
4. If the identity is already linked elsewhere, require an explicit supported
   account-recovery/linking operation. Never silently move machine ownership.
   Expire pending authorization and consume it atomically once before code
   exchange. Missing, mismatched, replayed, denied or interrupted callbacks must
   install no credentials. Serialize refresh per registration and atomically
   replace rotating credentials; account switches must not mix token sets.
5. Linking does not grant a ChatGPT connector access to o8 tasks, authorize
   inference or enroll another computer. Present each consent separately.
   Identity and plan use imply no access to conversations or memories. Any
   selected context transfer remains explicit and bounded.

These rules follow the identity validation and account/session contracts in
OpenAI's [sign-in guidance](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
and [profiles and sessions guidance](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions).

## Consent, disconnect and payer changes

Present three independent purposes: connect ChatGPT to o8 tools, sign in to o8
with ChatGPT identity, and let eligible o8 inference use a ChatGPT plan. Show the
current account/workspace and permitted action class. Acceptance of one purpose
must not grant another. See [usage routes](./chatgpt-plugin-usage.md).

Revoking a hosted grant must deny subsequent protected tool calls. It does not
undo an already admitted worker, delete durable evidence, approve a result or
change the worker's account. Inspect in-flight uncertainty before sending a
replacement instruction. Removing local credentials alone does not prove issuer
revocation. No disconnected grant may admit new work.

Disconnecting plan-use permission must stop subsequent app inference through
that grant. Retain task/report state and offer reconnect or explicit route
selection. A cap or authentication error must not automatically select API
billing, another user/workspace or another provider. A fallback needs a visible
account/payer and an operator decision unless that exact fallback already has
specific authorization. Apply this boundary to #2951's proposed fallback before
implementing it.

Desktop sign-out invalidates its own account/device-renewal path. It does not
prove that a separate hosted OAuth or OpenAI plan grant was revoked. Test each
recipient independently. Failed or uncertain remote revocation must remain
visible; do not report successful disconnect solely from a local deletion.

## Required entry-point tests

| Test | Real entry point and persisted proof | Current status |
| --- | --- | --- |
| Hosted expected grant | Official client consent, protected read and desktop audit | Passed on the existing private account |
| Wrong client or audience | Actual OAuth/resource verifier; refusal before disclosure or dispatch | Source boundary reviewed; live isolated cases pending |
| Live read-only scope | Official grant omits follow-up; read succeeds and follow-up cannot dispatch | Pending; minted local capabilities do not satisfy this case |
| Expiry and refresh | Natural expiry, refresh grant event and later protected read | Pending; a new authorization-code login or unexpired read is not refresh proof |
| Issuer revocation | Supported isolated revoke, protected read denial and refresh denial | Pending; official-client credentials must stay in managed storage |
| Other account | Second isolated identity targets the first identity's actual machine/task | Pending; nonexistent-machine denial is not ownership proof |
| Consent denial/account switch | Official decline/account selection; no stale task/account reuse | Pending; preserve the active everyday connection |
| Local plugin capability | Real middleware/route and persisted state; wrong scope/machine, expiry and forbidden operator paths | Source tests passed; current installed completion report passed |
| OpenAI identity linking | Fresh profile and stub OIDC callback through the real linking route; persisted issuer/subject association and replay/mismatch refusal | PR #3304 tests identity validation for an existing o8 account; replacement account sign-in remains a separate implementation gate |
| Plan grant/cap/revocation/account switch | First inference through stub provider and transport; correct registration/workspace, no unexpected payer and persisted task hold | PR #3304 source fixtures passed; installed and live provider acceptance remains open |
| Offline reviewer computer | Dedicated review computer disconnect; no queued execution or invented stale result | Pending; preserve the active everyday computer |

Live scope, ownership and revocation cases need operator-owned isolated
identities, managed official-client storage and a supported isolated desktop or
profile. Prepare the exact grant and cleanup before provisioning. Do not change
global lifetimes, allowed client URLs, open registration, provider settings or
active grants merely to make a test possible.

[Clerk documents a one-day access-token lifetime](https://clerk.com/docs/guides/configure/auth-strategies/oauth/how-clerk-implements-oauth).
Record actual grant expiry through supported metadata before scheduling an
expiry test. A successful read inside that lifetime does not prove refresh.

## Controlled worker credential preparation

Controlled worker credential source under [#3310](https://github.com/hurttlocker/o8/issues/3310)
uses a per-run bearer with zero API capability, filters ambient service secrets and
shell preload variables, and supplies no operator MCP attachments. Config-file
adapters receive an explicit empty MCP configuration. Middleware refuses the bearer
before public/self-authenticated exceptions; worker protocol handlers also refuse it.
Stop, terminal persistence and launch failure revoke the identity. Ordinary packet
workers retain their existing credential and attachment behavior.

Actual owned Node children, HTTP middleware/worker-event routes, SQLite, stop and a
cold resolver exercise the source boundary. Provider inference and the mandatory OS
sandbox are substituted, so installed isolation and native login acceptance remain
unproved. This grants no hosted execution scope. Permanent account/task/attempt
admission and stop preparation are described below; hosted consent and installed
qualification remain open under #3249.

## Controlled task admission preparation

Source under [#3312](https://github.com/hurttlocker/o8/issues/3312) adds the local
operator-only `POST /api/plugins/task-drafts/control` decision. Its exact body is
`action` (`launch`, `inspect` or `stop`), `taskId` and `contractHash`. The route is
absent from the hosted MCP catalogue. Read, follow-up and prepare grants cannot use it.

The held contract, original account/sign-in epoch, exact native runtime/model/effort
and one permanent attempt ID bind before workspace or session creation. A reservation
is never removed or aged out. Duplicates observe its receipt; missing/corrupt evidence
or uncertain publication holds execution. Mutable state uses an exact-process lease
that can recover a proven dead owner, while live or unknown owners remain protected.
New reservation/receipt directory entries and their parent directories are synced
before process effects.

Preparation creates a detached Git worktree at the reviewed revision without fetch,
rebase, setup scripts, dependency materialization or environment-file copies. Every
Git probe and checkout suppresses hooks, filters, filesystem monitors and optional
index writes. Submodule workspaces are held. If suppressing a configured transform
changes the requested file bytes, launch is held for review. Final source/project,
revision/rules, file and worktree checks execute under the shared account admission
lease. That lease encloses permanent spawn reservation, owned run journal publication
and actual process creation. The native single-attempt/read-only sandbox and restricted
credential profile remain authoritative. Requested file scope is task context; the
mandatory sandbox enforces repository write denial, not a file-read ACL.

Stop publishes its intent and revokes the run credential before any signal. An
authenticated local operator can stop that exact persisted task/run after sign-out,
license expiry or fresh sign-in to the same account; an active different account
cannot stop the prior account's task through this route. Completion and stop need
process-group/marker clearance; unknown evidence stays held. A clean child exit leaves
`reviewRequired: true`. The route has no resume, approve, merge or release action.
Workspace, session and transcript evidence remain retained for operator review.

The qualification fixture crosses the actual operator/MCP routes, signed account
journal, Git/project state, permanent reservation, runtime launch and owned Node child.
Provider inference and the mandatory OS sandbox are substituted. This source evidence
does not establish installed native isolation, direct hosted launch, consumer-plan
inference eligibility, public publication or allowance savings. Hosted execution
consent/relay admission and the installed reviewer trial remain separate gates.

## Source and follow-on work

Desktop Settings > MCP exposes held tasks for the current signed-in account.
The operator reviews the exact contract hash, revision, rules, file scope and
native runtime/model/effort before selecting Launch reviewed task. Inspect reads
the existing permanent attempt; a lost launch reply keeps launch disabled. Stop
names the exact task and requires confirmation. Account changes clear private
details and invalidate delayed responses. A previously viewed running attempt
retains only its exact Stop handle after sign-out. This screen grants no hosted
execution authority, automatic retry, approval, merge or release permission.

The mounted interaction tests cover delayed account-switch responses, uncertain
launch receipts, exact Stop binding and sign-out. The real operator-route test
checks contract/attempt projection and non-operator rejection against persisted
state. These fixtures do not establish installed or live-provider acceptance.

- [Device grant persistence](../../src/lib/auth/device-session-store.ts)
- [Device renewal and revocation service](../../src/lib/auth/device-session-service.ts)
- [Local plugin capability](../../src/lib/auth/plugin-token.ts)
- [Plugin handlers](../../src/lib/mcp/plugin-host.ts)
- [Principal tests through the real route](../../tests/plugin-principal-real-path.test.ts)
- [Hosted submission boundary](./openai-plugin-submission.md)
- [Usage measurement](./chatgpt-plugin-usage.md)
- [Sign in with ChatGPT implementation and eligibility](https://github.com/hurttlocker/o8/issues/2951)
- [Connection lifecycle acceptance](https://github.com/hurttlocker/o8/issues/2952)

This design grants no production access and does not establish plan inference,
new remote task creation or public readiness.
