# o8 connected plugin and submission

The package for [#2952](https://github.com/hurttlocker/o8/issues/2952) includes a
hosted MCP connection in its first submission. Source preparation does not
establish a live service, Directory acceptance, or public availability.

## Package

[`plugins/o8/plugin.json`](../../plugins/o8/plugin.json) uses the portable Agent
Plugins format. [`mcp.json`](../../plugins/o8/mcp.json) declares one Streamable
HTTP server at `https://relay.o8.run/mcp`. The connected workflow works with
hosted tools; two additional Codex skills use the installed local o8 CLI for
status and scoped new work. The icon and resources travel with the package.
The package version is independent of the desktop app version.

[`.agents/plugins/marketplace.json`](../../.agents/plugins/marketplace.json)
provides local catalog discovery without changing enabled plugins. Discovery,
installation, authentication, and a successful tool call are separate receipts.

The [submission rules](https://developers.openai.com/plugins/deploy/submission)
currently prohibit adding MCP to a submitted skills-only plugin. Keep the
connected server in the initial ZIP. Endpoint changes also require support;
confirm the public URL before uploading.

## Hosted capability boundary

The connection can list connected computers, page through tasks needing
attention, read a compact result, and send an explicitly requested follow-up.
The preparation feature also lists registered project choices and stores one
explicitly requested read-only task draft with sealed requirements and exact
runtime/model/effort pins. A new draft remains held until the operator reviews
and launches it in o8. `o8_task_result` reads its status and the bound completed
worker report with `o8:read`; it cannot dispatch, retry or recover a worker.
Preparation retries report persisted execution state without starting work.
No hosted tool approves, merges, releases or calls the unrestricted operator
MCP registry. New work directly from local Codex uses the local handoff skill.

Account linking uses the existing account provider's OAuth service with PKCE,
consent, custom `o8:read`, `o8:follow-up` and `o8:prepare-task` scopes, a registered client, and an
exact resource audience. Every hosted tool call verifies the access token,
expiry, revocation, permitted client, resource audience, and required scope.
Connection access does not add a paid-plan gate. Features invoked by an
existing task retain their ordinary entitlement and usage enforcement.

See [usage routes and measurement](./chatgpt-plugin-usage.md) for the distinction
between deterministic task reads, worker execution and host conversation usage.
The connection does not establish a subscription capacity benefit.

See [account and consent boundaries](./openai-account-consent.md) for hosted
OAuth, desktop device renewal, proposed OpenAI identity linking and separate
plan-use permission. Their credentials and disconnect behavior are independent.

An enabled, signed-in desktop machine connection is required. The desktop
advertises support for the plugin protocol before the hosted service can
select it. Older app connections never receive a plugin stream. The new
stream cannot open an operator realtime bridge or replay arbitrary HTTP paths.
It receives a distinct local plugin credential for `/api/plugins/mcp` only.

Follow-ups use persisted argument binding and idempotency for ten minutes.
Reuse the exact arguments and key only within that window after a timeout.
After expiry, inspect the task and obtain a new instruction before sending
another follow-up. An acceptance receipt is not completion;
an unresolved receipt calls for inspection, not a second instruction.
Desktop execution calls persist local plugin audit records without message
or result bodies. Operators can read the latest records through the gated
`GET /api/plugins/audit` route. Computer discovery is transient relay metadata;
it does not create a desktop task execution audit. Disconnected computers
receive no queued calls.

Controlled task results require the relay's verified account subject and the
desktop's matching current sign-in generation. The draft machine and original
client binding, sealed contract, execution attempt, single owned run and pins
must match. Reads do not refresh or reconcile runtime state. A final report
requires the bound provider terminal result, a clean child exit, and absence
of the owned process group and marker; missing, oversized, symlinked or
mismatched evidence returns unavailable. Only bounded sanitized assistant
report text is returned, excluding prompts, reasoning and tool output.

The hosted plugin path processes calls and results in plaintext under TLS.
It does not log, persist, or queue payloads. Publish the accurate privacy
disclosure before launching. The paired phone's encrypted traffic uses its
existing separate path.

## Verification before public submission

1. Validate the manifest, MCP schema, skill frontmatter and metadata, icons,
   package-relative links, URL lengths, and ZIP contents. Exclude credentials,
   logs, repository internals, local runtime state, and symlinks.
2. Exercise the limited credential through the real middleware and route.
   Prove persisted state reads, exact retry deduplication, key conflicts,
   expiry, scope and machine binding, stopped-task holds, forbidden tools,
   approval and merge refusal, and plugin-attributed audit records.
3. Exercise the machine WebSocket connector and local HTTP entry point. Prove
   plugin credentials reach the route and operator credentials are neither
   forwarded nor returned. Refused paths must not reach the local server.
4. Exercise hosted MCP discovery, token verification, signed machine ownership,
   old-app exclusion, offline handling, body bounds and rate limits. Confirm
   proxy client-address behavior in the deployed environment. Keep one service
   replica until the account limiter is shared across instances.
5. Run the repository's required type, test, lint and rule checks. Test the
   account provider's real PKCE, consent, audience, refresh and revocation flow
   after configuring the reviewed development client.
6. In Codex desktop and CLI, install the reviewed package, authenticate and
   execute an actual status request. In ChatGPT developer mode, use the same
   HTTPS endpoint and complete a phone-to-desktop follow-up on a disposable
   task. Inspect its visible result and audit in the installed app. Fixtures
   and catalog listing alone do not prove this outcome.
7. Test five positive and three negative reviewer cases, including offline,
   revoked and missing permission. Prepare a dedicated sample account and a
   demonstration video that contains no private workspace data.
   See the [reviewer walkthrough](./openai-plugin-reviewer-walkthrough.md).

For local lead commands, `node scripts/verify-lead-handoff.mjs` probes CLI,
route, persistence, retries, wait and stop. The separate `o8 mcp install --codex`
acceptance item remains tracked in #2952; packaged CLI skills do not require it.

## Publisher and activation

Confirm the publishing organization, project, role, and verified identity.
The dashboard sets the public developer name from that identity. Verify that
website, support, privacy and terms identify the publisher and are accessible.
Do not treat an existing unrelated organization as the chosen publisher.

This package uses its creator's public individual name. Select the approved
individual identity in the dashboard and reconcile its displayed name before
submission. The service operator named in the privacy policy and terms remains
the legal provider; choosing an individual publisher does not change it.

Prepare configuration and deploy approval separately from code review. The
hosted implementation remains unavailable until the account provider and
service configuration are set. Do not invent credentials or change a user's
OAuth settings as part of package validation.

The domain challenge must contain the portal-generated token verbatim at
`https://relay.o8.run/.well-known/openai-apps-challenge`. Return only one exact
plaintext token: no JSON, list, or added newline. If another plugin already
uses that challenge URL, use an eligible parent domain or a distinct hostname;
never replace its token or combine tokens. A challenge response alone does not
prove the MCP service or OAuth flow works.

## Upload, review, publication

Create a ZIP with one top-level `o8/` directory containing the package files.
Open the [Plugins dashboard](https://platform.openai.com/plugins), choose
**Upload new or existing plugin**, and select the reviewed connected package
under the verified publisher. Preserve scan findings and the resulting draft
ID. Complete MCP setup and the reviewer evidence before submission.

Policy attestations and review submission require the publisher's decision.
Publication is a separate action after approval. Record the draft ID, review
outcome, and public listing URL separately. Keep #2952 open until its actual
acceptance conditions are met.

## Official references

- [Package format](https://developers.openai.com/plugins/build/plugins)
- [Skill requirements](https://developers.openai.com/plugins/build/skills)
- [OAuth and resource metadata](https://developers.openai.com/plugins/build/auth)
- [Submission and publication](https://developers.openai.com/plugins/deploy/submission)
- [Plugin guidelines](https://developers.openai.com/plugins/plugin-guidelines)
- [Submission errors](https://developers.openai.com/plugins/deploy/submission-errors)
