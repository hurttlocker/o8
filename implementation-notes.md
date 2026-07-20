# Implementation Notes

## Approach

- Applied the preserved `5045d89a` extraction without committing it, then reconciled current-main behavior into the focused `run-controller`, `review-tail`, `fleet`, and store orchestration modules.
- Kept detached child-exit observation and completion persistence in `run-controller.ts`.
- Kept adapter-provided launch stdin payloads on both the bridge command and detached child stdin paths.
- Preserved current-main run-log caching, sandbox fail-closed behavior, Node PATH repair, cold resume, archived telemetry, session-state lookup, and guarded orphan cleanup.

## Verification

- `npx tsc --noEmit` passed.
- Focused owned-session, child-exit, cold-resume, completion-push, orphan-sweep, session-state, and dispatch-spawn tests passed: 7 files, 16 tests.
- Full `npm test` passed: 378 files and 2,421 tests passed; 1 file and 1 test skipped.
- Scoped ESLint passed for all six changed TypeScript files.
- `npm run rule-check -- --base=main` passed with zero violations.

## Deviations

- None.
