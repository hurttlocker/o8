# Verification receipt

Base: `2af6df632` from `origin/main`. All execution used an isolated checkout and
owned fixture state. No installed-app server or data directory was used.

| Check | Result |
| --- | --- |
| Release Rust build, locked, x86_64-apple-darwin | Passed |
| Rust tests | 2 passed, including all three recorded web trees and origin restrictions |
| Web render-tree checks | 5 passed locally and in isolated Linux verification |
| Actual built CLI -> native -> asynchronous HTTP -> content paint | Passed; only the two existing GET contracts, 6 requests in the final protocol run |
| Invalid native invocations/recording | Rejected before application startup |
| Inherited database override | Seeded outside the host's data directory; verified never opened |
| Benchmark receipts | Three fresh processes; 20 acknowledged keys and 50 scroll scenes each; first and last transcript rows painted |
| Root TypeScript completion gate | Passed with CI's 8 GiB heap setting; initial default-heap attempt exhausted Node heap |
| Focused new CLI command TypeScript check | Passed |
| Broad CLI project check | 28 diagnostics, exactly matching the original base after normalizing shifted line numbers; no new diagnostics |
| Initial local hermetic gate | 1197 files and 8464 tests passed, 3 files/4 tests skipped; exit 1 came solely from an untracked AppleDouble transfer file parsed as a test. Clean checkout/rerun result is recorded in the PR checks/body. |
| ESLint on six touched TypeScript files | Passed |
| Rule check against pinned base | Passed, five scanned files, zero violations |
| Test-classification manifest | Passed |
| Rust format | Passed |
| Linked/build license graph | 441 packages, no declared GPL or excluded application crates |
| Unattended capture helper | Swift typecheck passed; never executed |

The broad CLI project's existing diagnostics include an ES2022 `findLast` library
mismatch, unresolved `@/` imports, and unrelated command/test type errors. Both
base and changed checkouts returned the same 28 diagnostics. The new command
passes its focused strict typecheck and was exercised through the bundled CLI.

The preview-only read-tool regression was reproduced through persisted history,
the actual history GET route, the production web renderer, and the native binary's
render-tree entry point. Native grouping differed before the correction. The
corrected command fallback matches all three histories and their tool groups.
Order, code-byte and tool-group mutations are also detected by the web checks.

A separate read-only source review found and then confirmed fixes for the inherited
database override, stale refresh/history responses, preview-only grouping,
strike-through, and the scroll timing boundary. Runtime receipts above were run
by the implementation owner; the source review was not treated as execution proof.

Measurement UI source SHA-256:
`30bf81079086d7fb5b23864cd0627f77b2fc6924e4c10079a637895474ae2703`.
Measured release binary SHA-256:
`c0b231d4235ff6fc00faa738f17fd6796b7ed5fa6297b0d015bcdb1c2d99436b`.

Residual: this is static saved orchestrator history over authored disposable
recordings. It is not live-provider, WebSocket, GPU/compositor, full rich-event,
or compact/wide visual acceptance. Issue #4405 stays open. PR #4362 stays a draft.
