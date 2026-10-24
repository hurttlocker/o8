# Native diff/review evidence (#4531)

This slice adds an opt-in read-only packet/worktree diff surface on main. The
normal transcript/composer, terminal PR and shipped Tauri app are independent.
No application server routes, release or publishing files change.

## Entry points and regression order

The HTTP regression was written and run before implementing the fixture and
native surface. It starts the existing disposable dev-server pattern, crosses
production middleware, reads actual Git changes through the production packet
diff handler, posts decisions through the production review handler, then reads
persisted review state. No provider or account participates.

Red output is retained in [server red](red-server-tail.txt),
[native CLI red](red-cli-tail.txt), and [mode metadata red](red-metadata-tail.txt).
Completion summaries are retained in [green tails](green-tail.txt).

```text
FAIL tests/next-diff-review-real-path.test.ts
AssertionError: expected 404 to be 200
Test Files  1 failed (1)
Tests  1 failed (1)

test diff_cli_is_explicit_and_documents_both_targets ... FAILED
assertion failed: help.contains("--review-packet ID")
test result: FAILED. 0 passed; 1 failed

assertion failed: metadata.files[0].lines.iter().any(|line| line.text == "old mode 100644")
test result: FAILED. 0 passed; 1 failed
```

The native regression uses GPUI TestAppContext, the actual Client and the same
HTTP production handlers. It clicks file, view-mode, decision and retry controls;
checks persisted reject/approve state; drops a response after persistence and
retries; changes working-tree content at the same HEAD; and verifies refusal
after production colored Git output or a byte-truncated packet diff. It checks
all four file states and both rename paths. Parser checks cover TypeScript,
Rust, Markdown, JSON, UTF-8 style boundaries, multiple hunks, unequal split
blocks, quoted Git paths, binary notices, mode metadata and incomplete patches.
The native executable test validates explicit opt-in, both documented targets
and conflicting flags without opening a window.

```text
Test Files  3 passed (3)
Tests  11 passed (11)

test result: ok. 12 passed; 0 failed
tests/diff_cli.rs: test result: ok. 1 passed; 0 failed

npm test:
Test Files  1219 passed | 3 skipped (1222)
Tests  8651 passed | 4 skipped (8655)
Duration  356.84s
```

Tests: `tests/next-diff-review-real-path.test.ts`,
`tests/next-render-parity.test.ts`, `tests/next-stream-parity.test.ts`,
`native/o8-next/src/diff_tests.rs`, `native/o8-next/tests/diff_cli.rs`, plus the
complete existing Rust suite. The existing `verify.ts --protocol-only` runner
passes through the actual executable: all three HTTP/render-tree recordings
match without regenerating fixtures, and only the five existing GET contracts
are used.

| Mechanic | Before | After |
| --- | ---: | ---: |
| Native diff modes | 0 | 2 (unified, split) |
| Highlighted diff languages | 0 | 4, plus TSX |
| Fixture file states represented | 0 | 4 across 6 files |
| Largest changed-line fixture | Unavailable | 20,000 |
| Rows painted per viewport in that fixture | Unavailable | At most 51 of 20,003 |
| New HTTP / CLI regressions | 1 failing each | 1 passing each |

## Reproduction and checks

Node 22.23.4, Rust 1.99.1, Linux, optimized Cargo profile. Linux linking needs
the XCB, xkbcommon and xkbcommon-x11 development linker names; this environment
used workspace-local names for its already-installed runtime libraries.

```sh
mkdir -p work
NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit
npx vitest run tests/next-diff-review-real-path.test.ts tests/next-render-parity.test.ts tests/next-stream-parity.test.ts
npx eslint scripts/next/dev-server.ts scripts/next/review-fixture.ts tests/next-diff-review-real-path.test.ts
npm run rule-check -- --base=origin/main
node scripts/classify-tests.mjs --check
npm test
cargo test --release --locked --manifest-path native/o8-next/Cargo.toml -- --test-threads=1
O8_NEXT_BINARY="$PWD/native/o8-next/target/release/o8-next" node --import ./scripts/register-server-only-stub.mjs --import tsx scripts/next/verify.ts --protocol-only
```

TypeScript, touched-file ESLint, changed-file rule check (two eligible scripts,
zero violations), classification and touched Rust formatting pass. The
normal-feature `cargo build --release --locked` also passes, separately from the
GPUI test-support build. The
independent read-only decision-boundary review found no remaining blocker after
the unsupported-patch and metadata regressions were corrected.

The crate's existing `scripts/next/license-audit.mjs` passes for both locked
normal/build graphs: **467 Linux / 450 macOS packages, zero GPL or excluded
application crates**. The five new grammar/parser dependencies and their two
new transitive dependencies declare MIT licenses. See
[audit summary](license-audit.json). Audit commands:

```sh
O8_NEXT_TARGET=x86_64-unknown-linux-gnu O8_NEXT_LICENSE_OUTPUT=work/linux-licenses.json node scripts/next/license-audit.mjs
O8_NEXT_LICENSE_OUTPUT=work/macos-licenses.json node scripts/next/license-audit.mjs
```

## Measurements

Three sequential fresh fixture-host/native-test runs; [run 1](run-1.json),
[run 2](run-2.json), [run 3](run-3.json) retain all sorted frame samples.
Each sample opens a selected file in a warm process, starting immediately before
the asynchronous HTTP load and ending after the first GPUI CPU scene draw. This
includes Git transport, parsing and syntax preparation. It excludes process
launch, fixture startup and an actual display presentation. Every first/last
viewport jump asserts its target row's paint callback; every wheel draw asserts
nonempty bounded row callbacks. There are 50 alternating first/last jumps and
50 platform wheel events per fixture/mode. p95 is nearest-rank sample 48 of 50.
RSS is the native test process only, including its test harness; the separate
Node server is excluded. Results below are medians of the three per-run values.

| Mode | Changed lines | Open to CPU paint ms | Wheel frame p95 ms | Jump frame p95 ms | RSS MiB |
| --- | ---: | ---: | ---: | ---: | ---: |
| Unified | 1,000 | 48.468 | 2.456 | 2.835 | 43.273 |
| Unified | 20,000 | 128.893 | 2.607 | 2.471 | 43.273 |
| Split | 1,000 | 52.925 | 2.926 | 3.564 | 43.406 |
| Split | 20,000 | 149.987 | 2.585 | 2.932 | 43.406 |

```sh
O8_NEXT_DIFF_EVIDENCE="$PWD/work/diff-run.json" cargo test --release --locked --manifest-path native/o8-next/Cargo.toml diff_real_server -- --nocapture --test-threads=1
```

## Remaining acceptance

The headless GPUI test text system supplies no native font shaping, GPU
submission or compositor presentation. These receipts prove bounded scene work
for 20,000 changed lines and CPU test-scene timings, not an on-screen guarantee
of scrolling without frame drops. Native-font open-to-presentation and scroll
frame p95, and compact/wide visual acceptance on a real display, remain
unverified. No native diff existed for a comparable before-performance baseline.
The existing server byte limits remain in force; larger/unsupported patches
disable decisions and label the limitation rather than silently approving a
partial view. This residual keeps #4531 open.
