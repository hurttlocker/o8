# Implementation notes — #1741 Windows CLI shim + PATH registration

## What shipped

Add `prime-agent` as the 14th dispatchable runtime, following the specialized-adapter
recipe in `docs/internals/runtime-adapter-contract.md`, modeled on `src/lib/grok/owned.ts`
(one-shot JSON-mode process, not Pi's hand-rolled bidirectional RPC — prime-agent shares
grok's shape for v1: launch/resume via argv, parse stdout after the fact).

- `src/lib/prime-agent/owned.ts` — adapter built on `createOwnedSessionStore`. Launches
  `prime-agent -p <prompt> --mode json --session-dir .o8-prime-agent-sessions`; resumes
  via `-r <sessionId>`. `--session-dir` is a path relative to the spawn cwd, which the
  shared store always sets to `session.repoPath` (the packet worktree), so prime-agent's
  own JSONL state travels with the worktree instead of piling up in the shared
  `~/.prime/agent/sessions/`. Parser reads the first JSONL line as the session header
  (per the CLI facts) and defensively maps message/tool/result/error event shapes.
- `src/lib/runtimes/prime-agent.ts` — `AgentRuntime` implementation, capability-gated on
  `resolveCli` finding the `prime-agent` binary (absent binary → `discoverSessions()`
  returns `[]`, matching every other adapter).
- `src/lib/runtimes/prime-agent-cost-parser.ts` — conservative parser: reads embedded
  usage/stats fields if present, never invents a cost estimate (unlike Grok's fixed-price
  parser) since prime-agent runs on the operator's own provider/model choice.
- `src/lib/orchestrator/runtime-capabilities.ts` — new `'prime-agent'` catalog entry,
  `tier: 'standard'` (qualifies for Brain-auto), accent `#0ea5e9` (unused so far).
- `src/lib/runtimes/index.ts` — registered adapter + cost parser + fleet-cache invalidation.
- `docs/internals/runtime-adapter-contract.md` — updated runtime count (14→15 total,
  13→14 dispatchable) and the specialized-runtimes list, within the packet's diff budget.

## Deviations

- **Skipped editing `src/lib/orchestrator/types.ts`.** The packet's step 4 assumed a
  second `OrchestratorRuntime` union to update, but `types.ts` re-exports the type
  directly from `runtime-capabilities.ts` (`export type { OrchestratorRuntime } from
  '@/lib/orchestrator/runtime-capabilities'`) — exactly what the contract doc promises
  ("that one entry generates... the `OrchestratorRuntime` type"). No edit was needed or
  made there.
- **Two switch cases tsc forced, as the contract doc predicted**: `src/lib/orchestrator/cost-aggregator.ts`
  (`tokensByRuntime` exhaustive record) and `src/lib/runtime/registry.ts`
  (`RUNTIME_BINARY_NAMES` exhaustive record, keyed by `LaneRuntime = OrchestratorRuntime`).
  Both got a one-line `prime-agent` entry.
- **A third case tsc could NOT catch, but `npm test` did**: `src/lib/runtimes/shared/auth-detect.ts`'s
  `detectRuntime()` switch has a non-exhaustive `default` that falls through to
  `detectDeclarativeRuntime()` — which throws for any non-declarative runtime missing a
  `declarative` manifest. Since prime-agent is specialized (not declarative), every
  dispatch-readiness check would have thrown at runtime. Added `detectPrimeAgent()`
  (modeled on `detectPi()`/`detectOpencode()`: checks common provider env vars plus a
  `~/.prime` directory) and a `case 'prime-agent'` in the switch. This file isn't in the
  packet's 6-file list, but leaving it broken would mean prime-agent could register as a
  runtime yet never pass an auth-readiness check — a real reachability gap the test
  caught, not a hypothetical one.
- **`--model` flag never passed.** prime-agent picks its own model via its own config
  (task spec: "the adapter does NOT manage keys"); `requiresModel: false` and no
  `defaultModel` in the capability entry, matching Pi/Goose rather than Grok/opencode.
- Pre-existing, unrelated `npm test` failures (`act is not a function` in several
  `src/components/desktop/**` tests) were confirmed present on the same commit with this
  branch's changes stashed — not caused by this packet.

Windows CLI shim + PATH registration (#1741): shipped `o8.cmd`/`o8.ps1` and first-run PATH registration; full summary in `docs/internals/port-audit-windows.md` "Status (#1741)".
