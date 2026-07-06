# 010 — Regression-guard test pack for the three known-trap surfaces

## What & why
Three surfaces with documented regression history have zero or partial test coverage. Each guard is cheap; each regression it prevents has already happened once:

1. **`compactPacketLabel`** (`src/lib/workspace-terminal/compact-packet-label.ts:31`) — ZERO tests. Pure function guarding the "never slice sessionKey for a name" root fix (label-derivation memory). A regression silently mislabels every agent tab. Trivial unit test, top ROI.
2. **Terminal-status classification** — `reviewing` + `silent_exit_*` must be treated as terminal by pollers (packet-watcher trap: a poller that misses this hangs forever). Statuses are consumed across `src/lib/orchestrator/scheduling.ts`, `src/lib/orchestrator/operator-mission-service/merge.ts`, `src/lib/lane/registry.ts` — but there is **no single tested `isTerminalStatus()` classifier**; each site hand-rolls the check. That absence is itself the bug surface.
3. **`normalizePacket` completeness** — `tests/packet-control-fields-survive-normalize.test.ts` pins only a hand-listed SUBSET of fields; any new field outside the list still evaporates on round-trip (normalizePacket trap, has eaten fields before). `src/lib/orchestrator/store.ts` (~1048 lines) vs. the packet type in `src/lib/orchestrator/types.ts`.

## Exact change
1. New `src/lib/workspace-terminal/compact-packet-label.test.ts`: cover normal labels, the sessionKey-must-not-leak case (a label that would previously have been a sliced sessionKey), empty/degenerate inputs. Derive cases from the function's actual branches — read it first.
2. Introduce `isTerminalStatus(status): boolean` in the status types module (find where the status union lives — likely `src/lib/lane/types.ts` or `src/lib/orchestrator/types.ts`), returning true for the full terminal set incl. `reviewing` and every `silent_exit_*` prefix. Unit-test it exhaustively against the status union (a test that iterates the union type's runtime list, so adding a status forces a decision). Then replace the hand-rolled checks at the consuming sites with the classifier — **mechanical substitution only; do not change any site's effective set** (where a site's set genuinely differs, keep its behavior and note it in the report rather than "fixing" it).
3. Extend the normalize test: build a fully-populated packet via the type's key set (use a runtime fixture that fails compilation/test when the type gains a key it doesn't cover — e.g. `satisfies Required<Packet>`), round-trip through `normalizePacket()`, and assert deep-equality of every key. This makes new-field evaporation a red test instead of a memory-file trap.

## What NOT to touch
- Status semantics, packet field semantics, any UI. Tests + one additive classifier + mechanical substitution only.

## Acceptance criteria
- Mutation checks (do locally, don't commit): slicing a sessionKey into the label → test fails; removing `silent_exit_x` from the terminal set → test fails; dropping any field from `normalizePacket` → test fails.
- All consuming sites of terminal-status checks use the classifier or carry a noted justification.

## Verification
```bash
npm run typecheck && npm test
```

## Failure path
If site substitution in step 2 changes observable behavior anywhere (a test elsewhere goes red): revert that site only, keep the classifier + tests, report the divergent site — that divergence is a finding, not something to silently normalize.

## Executor tier
Sonnet or Codex via o8 dispatch. Review by `reviewer` agent before done.
