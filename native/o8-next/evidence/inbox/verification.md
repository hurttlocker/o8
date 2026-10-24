# Native Inbox verification

Linux, Node 22.23.4, Rust stable 1.99.1, release profile, locked dependencies.
All windows use the GPUI test context and the production shell's offscreen
window options. No desktop, operator account, or provider session is used.

## Real entry points

`src/inbox_tests.rs` starts the existing `scripts/next/dev-server.ts` fixture
host with `--shell --inbox`. The fixture persists GitHub mirrors, incidents and
approvals. Its oracle calls the actual desktop Inbox GET handlers and the
desktop reply-queue function. The native view independently reads those routes
over HTTP through production middleware.

Tests type into the production shell palette, click view and decision controls,
scroll actions into view, and compare card identities, order, source, status and
counts. A separate desktop POST resolves a matching approval. Subsequent GETs
read both persisted approval records and compare action, actor, continuation
outcome, note and audit events, excluding generated identities and timestamps.
The native decision's persisted actor is `desktop`, as on the desktop path.

## Red before implementation

Command: `cargo +stable test --release --locked --manifest-path
native/o8-next/Cargo.toml inbox -- --nocapture --test-threads=1`.

```text
test shell::inbox_tests::inbox_cards_counts_statuses_and_approval_match_desktop_routes
assertion `left == right` failed
  left: "Session"
 right: "Inbox"
test shell::tests::inbox_is_reachable_from_the_real_shell_palette
  left: []
 right: ["Open Inbox"]
test result: FAILED. 0 passed; 2 failed; 0 ignored; 0 measured; 28 filtered out; finished in 3.66s
```

The added exact-session case also reproduced an existing saved sidebar
selection taking precedence over an Inbox session link:

```text
assertion `left == right` failed: the related session must replace a stale saved sidebar selection
  left: Some("thoughts-long")
 right: Some("thoughts-review")
```

The empty fixture was then reduced to zero saved sessions. Before global Inbox
support, the same shell entry point failed with:

```text
missing native control: inbox-view-replies
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 31 filtered out; finished in 3.16s
```

## Green after implementation

Focused Inbox tests: **4 passed, 0 failed**. Full native crate: **36 passed,
0 failed**, including six CLI integration tests. Two pre-existing explicit
measurement workloads remain ignored. The existing o8d saved-read test initially
needed its fixture executable; building the documented `experimental-http`
binary and setting `O8D_HTTP_TEST_BINARY` made the full run pass.

```text
test shell::inbox_tests::inbox_cards_counts_statuses_and_approval_match_desktop_routes ... ok
test shell::inbox_tests::inbox_empty_and_server_error_never_claim_a_false_clean_state ... ok
test shell::inbox_tests::inbox_opens_related_session_and_pull_request_and_restores ... ok
test shell::tests::inbox_is_reachable_from_the_real_shell_palette ... ok
test result: ok. 30 passed; 0 failed; 2 ignored; 0 measured; 0 filtered out; finished in 135.87s
```

| View | Desktop / native before decisions | Desktop / native after decisions |
| --- | --- | --- |
| Needs reply | 1 / 1 | 1 / 1 |
| Contributions | 2 / 2 | 2 / 2 |
| Approvals | 5 / 5 | 2 / 2 |
| Agent issues | 4 / 4 | 4 / 4 |
| History | 3 / 3 | 3 / 3 |

The decisions are one native approve, one native reject, and one matching
desktop approve. The worker's decision receives HTTP 403 and leaves its record
pending. An approved card with an unconfirmed continuation stays visible and
its disabled control leaves the persisted record unchanged.

The tests also cover deduplicated/dismissed GitHub replies, all four active
incident statuses, history statuses, PR URL opening, exact session navigation,
surface deduplication, restart restoration, all five empty states before any
saved session, global Inbox close/reopen and persistence, server-down
errors, and 900 x 700 / 1680 x 1050 geometry. Palette command through loaded
CPU scene was **49.92 ms** in the full verification run, concurrent with npm
checks. This is a test-context observation, not a performance target receipt.
Native font shaping, GPU/compositor presentation and physical input latency are
unmeasured. No `theme.rs` existed on the starting main baseline; colors remain
local to `src/inbox_view.rs`.

JavaScript completion gates: `npm test` finished with **1,230 files passed,
3 skipped; 8,855 tests passed, 5 skipped**. The first full run hit `ENOBUFS`
in the untouched release-artifact test because Git enumerated downloaded tools
under `work/`. Excluding scratch via local Git metadata made the focused
15-test file and the complete rerun pass; no release files were changed.
The desktop/launcher regression selection passed **9 tests in 3 files**:
`tests/o8-next-shell-real-path.test.ts`,
`src/components/desktop/O8InboxPane.test.ts`, and
`tests/outsider-waiting-inbox-real-path.test.ts`.

Both `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit` and
`npm run typecheck:fast` passed. ESLint passed on the two touched TypeScript
fixture files, the rule checker scanned those files with zero violations against
`origin/main`, and the touched Rust files passed rustfmt checks. Both release
builds and all five experimental o8d HTTP tests passed with `--locked`.

Commands:

```sh
cargo +stable build --release --locked --manifest-path crates/o8d/Cargo.toml --features experimental-http
cargo +stable test --release --locked --manifest-path crates/o8d/Cargo.toml --features experimental-http
cargo +stable build --release --locked --manifest-path native/o8-next/Cargo.toml
O8D_HTTP_TEST_BINARY="$PWD/crates/o8d/target/release/o8d" cargo +stable test --release --locked --manifest-path native/o8-next/Cargo.toml -- --nocapture --test-threads=1
```
