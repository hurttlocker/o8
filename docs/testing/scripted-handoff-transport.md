# Scripted cross-backend handoff transport

Run from a Node 22 checkout with dependencies installed:

```sh
npm run test:integration -- tests/orchestrator-handoff-transport-real-path.test.ts
```

This bounded Linux-compatible fixture uses the production composer payload builder,
WebSocket server, Claude and Codex orchestrator adapters, Git workspace inspection,
history store, approval store, lane ledger, and authenticated history route. The
provider CLI endpoints are scripted, and a small fixture HTTP server supplies
setup/health responses needed for startup. The WebSocket listener is constrained to
an ephemeral loopback port by a test-only preload. Temporary data, provider homes,
and credentials are synthetic; the subprocess environment does not inherit
provider credentials. No worker is dispatched and no model service is called.

## Evidence established

- A source turn is persisted through the real Claude adapter before switching
- A cross-backend send without the explicit composer handoff choice is rejected
  before acceptance, receiver invocation, history mutation, or handoff audit
- The accepted Codex turn receives the packet serialized by the production
  handoff builder, including prior narrative, measured staged/unstaged/untracked
  workspace evidence, pending approval, lane status, and consumed retry budget
- The operator's new message follows the historical packet and is not included in
  its prior narrative
- The live handoff event, durable history marker, desktop history projection, and
  receiver packet agree, with one non-lossless seam before the new user turn
- A same-backend follow-up does not generate another packet or audit seam
- After the WebSocket process exits, an independent process reloads the same
  packet, unresolved approval, lane status, retry counters, and linked history audit

## Boundaries

This proves scripted transport and persistence, not live-model comprehension or
continuation quality. It does not exercise worker-to-worker handoff, ACT authority
enforcement, native desktop behavior, or hosted providers.

The composer path does not supply structured intent in this snapshot. The test
expects `intent: null` and an omitted carry, rather than inventing intent continuity.
Workspace freshness is a point-in-time diagnostic. The test does not establish an
execution lease, close a time-of-check/time-of-use window, or authorize an action
in a differently targeted worktree. Legacy missing evidence remains legitimate.

The existing `tests/handoff-packet-real-path.test.ts` covers packet construction
and freshness diagnostics separately. Neither fixture changes admission rules,
resolves the pending approval, nor resets a retry budget.
