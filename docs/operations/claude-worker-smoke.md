# Claude Code runtime verification

Use this runbook when a release changes Claude Code spawning, model-source selection, the local Codex subscription carrier, session persistence, or usage telemetry. Deterministic tests prove the contracts without spending provider quota; the live tests prove that the installed CLIs and configured accounts still accept the real production path.

## Deterministic gate

Run the focused route, profile, spawn, carrier, parser, and stream tests:

```bash
npx vitest run \
  tests/claude-code-worker-profile-route.test.ts \
  tests/claude-code-dispatch-spawn.test.ts \
  src/lib/claude-code/worker-profile.test.ts \
  src/lib/claude-code/codex-subscription-oauth.test.ts \
  src/lib/lane/claude-harness-carrier.test.ts \
  src/lib/claude-code/stream-json-parser.test.ts \
  src/lib/lane/orchestrator-stream-events.test.ts
```

This gate must prove all three model sources remain separate, saved profiles contain no credentials, the Codex carrier binds only to localhost, each owned worker pins its source and model at launch, and cache-read/write tokens survive the stream parser.

## Live Codex subscription worker

The local carrier must already be installed and connected through **Settings → Models → Claude Code harness**.

```bash
O8_LIVE_CLAUDE_CODE_CODEX=1 \
  npx vitest run tests/claude-code-codex-subscription-live-smoke.test.ts
```

The test launches a real owned Claude Code worker backed by the connected Codex subscription, verifies the pinned source and model in persisted session metadata, waits for the exact response in the runtime transcript, then archives the session.

## Live Codex subscription orchestrator

```bash
O8_LIVE_CLAUDE_CODE_CODEX_ORCHESTRATOR=1 \
  npx vitest run tests/claude-code-codex-orchestrator-live-smoke.test.ts
```

The test loads repository instructions in a real orchestrator chat, sends a warm follow-up through the same process and Claude session, requires more than 90% prompt-cache reads on that follow-up, then proves that a second chat uses a different process, session, and carrier configuration directory.

## Live API gateway worker

Export the OpenRouter key through the maintainer's secure environment before running this test. Do not paste a credential into a command, test fixture, issue, or release log.

```bash
O8_LIVE_CLAUDE_CODE_GATEWAY=1 \
  npx vitest run tests/claude-code-gateway-live-smoke.test.ts
```

The test launches the configured tool-capable API model through the same owned Claude Code worker path, waits for its exact transcript response, and archives the session.

## Completion evidence

A release-changing pass is complete when the deterministic gate is green, each affected live path is green, `npm run typecheck` passes, the changed-file rule check passes, `git diff --check` is clean, and the candidate diff contains no credentials. Live tests are deliberate because they consume real provider usage; ordinary CI must keep them disabled.
