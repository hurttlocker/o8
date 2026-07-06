# 008 — Extract orchestrator-session-core from the diverging twins

## What & why
`src/lib/lane/orchestrator-session.ts` (1160 lines) and `src/lib/lane/codex-orchestrator-session.ts` (723 lines) are copy-paste twins: `normalizeRepoPath` and `repoHash` are byte-identical in both; `waitFor*Idle`, `ensure/get/reset/rehydrate*Session`, and `*SessionName` are name-for-name twins with **drifting bodies**. Both are top-churn files (1034+505 changed lines over the last ~400 commits). Every lifecycle fix must be hand-ported twice, which is exactly how "fixed in the Claude path, broken in the Codex path" bugs happen — and the orchestrator session lifecycle is the most regression-prone surface in the app (see #1459). Highest payoff debt item from the sweep.

## Exact change
- Create `src/lib/lane/orchestrator-session-core.ts` containing the genuinely shared logic: path normalization, repo hashing, state-dir layout, idle-waiting, session-record ensure/get/reset/rehydrate scaffolding — parameterized by a small backend interface (spawn, protocol write, liveness probe) that each of the two files implements.
- Reduce the two existing files to: backend interface implementation + anything truly protocol-specific. Keep their **public exports byte-compatible** (same names, same signatures) so no call site changes.
- Do it as a sequence of small commits: (1) extract byte-identical helpers, (2) unify one twin-pair function at a time, diffing the two bodies first and deciding which behavior is correct where they've drifted — **each drift is a latent bug; log every drift found and the resolution in the report**, (3) done when the twins contain no name-for-name duplicated logic.

## What NOT to touch
- Public module APIs (imports across the codebase must not change in this pass).
- The chat-tab REPL protocol itself (`#1066`: never `claude -p`).
- Don't fold in plan 002's fix if it lands first — rebase around it.

## Acceptance criteria (reachability-grade)
- Zero name-for-name duplicated function bodies remain across the two files (reviewer greps the pairs).
- Both real paths still work end-to-end: one Claude orchestrator session and one Codex orchestrator session driven live in dev — send, receive, reset, rehydrate (relaunch) each.
- Existing session tests green (`src/lib/lane/codex-orchestrator-session.test.ts` and siblings); drift resolutions listed in the hand-back.

## Verification
```bash
npm run typecheck && npm test
```
Then live in dev: exercise ensure→send→reset→rehydrate on both backends via the real UI.

## Failure path
If a drift-pair's correct behavior can't be determined from code/history after 3 attempts: stop on that function, keep both behaviors behind the backend interface (explicitly, with a comment), report the pair for a human ruling. If the extraction destabilizes either backend mid-way: revert to last green commit and report.

## Executor tier
Opus (multi-file refactor requiring judgment on every drift). Review by `reviewer` agent with refute posture — specifically re-diffing pre/post behavior of each unified function.
