# Native terminal verification (#4487)

The explicit native terminal mode attaches through the production ws-info handler,
production WebSocket server and a disposable Python PTY. Headless GPUI dispatches
input and paints the parsed grid. No operator machine, account or shipped Tauri
application was used or changed.

## Red receipts, before implementation

`tests/next-terminal-real-path.test.ts` was written and run through
`scripts/next/dev-server.ts` before adding its terminal mode. The native executable
regression in `native/o8-next/tests/terminal_cli.rs` also failed before the flag was
implemented. These are excerpts of the retained red output:

```text
FAIL tests/next-terminal-real-path.test.ts
AssertionError: fixture host must publish an existing terminal session: expected '' to be 'cortex-next-terminal-fixture'
Test Files 1 failed (1)
Tests 1 failed (1)

test terminal_pane_is_an_explicit_native_opt_in ... FAILED
assertion failed: String::from_utf8_lossy(&help.stdout).contains("--terminal SESSION_ID")
test result: FAILED. 0 passed; 1 failed
```

## Green receipts

```text
Test Files 3 passed (3)
Tests 11 passed (11)

test result: ok. 13 passed; 0 failed
terminal_cli.rs: test result: ok. 1 passed; 0 failed
release terminal runs (each): 3 passed; 0 failed; terminal_cli.rs: 1 passed; 0 failed

npm test: Test Files 1208 passed | 3 skipped (1211)
Tests 8563 passed | 4 skipped (8567)
```

The native pane count went from 0 to 1; retained terminal history from 0 to
10,000 lines. The two regression tests went from one failing test each to one
passing test each. Each release measurement delivered 50,000,000 workload bytes
plus the 12-byte completion marker, with no missing bytes at the declared rate.

Commands completed on Node 22.23.4 and Rust stable 1.99.1:

```sh
NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit
npx vitest run tests/next-terminal-real-path.test.ts tests/next-render-parity.test.ts tests/next-stream-parity.test.ts
cargo test --locked --manifest-path native/o8-next/Cargo.toml -- --test-threads=1
cargo test --release --locked --manifest-path native/o8-next/Cargo.toml terminal -- --test-threads=1
npx eslint cli/src/commands/next.ts scripts/next/dev-server.ts scripts/next/terminal-fixture.ts scripts/next/license-audit.mjs tests/next-terminal-real-path.test.ts
npm run rule-check -- --base=940631b30
node scripts/classify-tests.mjs --check
npm test
```

TypeScript, ESLint, rule-check (zero violations), classification and documentation
links passed. The first full npm run had 8,562 passes and one `git ENOBUFS` failure
in the unchanged release-artifact test: the temporary Cargo cache expanded Git's
untracked-file listing beyond that test's command buffer. Moving scratch storage
outside the checkout made the unchanged test pass; the full rerun is green above.
No release file was changed.

## Release measurements

Three sequential runs with other test suites stopped. CPU scene acknowledgement
in Linux GPUI TestAppContext, **not GPU/compositor presentation or physical input**.
Each run uses 30 timed Enter keystrokes through GPUI's platform input path and the
real terminal server/PTY. Local scene acknowledgement does not claim the echo is
visible; the separate echo endpoint waits for output bytes to reach a painted
scene. The 50 MB continuous flood runs at an explicit 2.5 MB/s for 20 seconds,
following the repository's fixed-rate terminal-workload pattern. Changed painted
revisions produce the frame samples. RSS is the native test process only, sampled
with its full 10,000-line scrollback; it excludes the separate fixture server.

| Run | Local key → scene p50 / p95 (ms) | Key → PTY echo → scene p50 / p95 (ms) | 50 MB flood frame p95 (ms) | RSS at 10,000 lines (MiB) |
| --- | ---: | ---: | ---: | ---: |
| 1 | 0.416 / 0.696 | 23.366 / 24.685 | 4.520 | 31.39 |
| 2 | 0.400 / 0.509 | 23.320 / 26.339 | 4.685 | 31.44 |
| 3 | 0.406 / 0.700 | 23.299 / 25.645 | 5.029 | 31.90 |


Full samples: [run 1](run-1.json), [run 2](run-2.json), [run 3](run-3.json).
No prior native terminal existed, so a before-performance baseline is unavailable.

## License audit

The existing `scripts/next/license-audit.mjs` passed for both locked normal/build
graphs: [465 Linux packages](licenses.json) and [448 macOS packages](licenses-macos.json).
Zero GPL packages and zero excluded application crates. GPUI 0.2.2 and
alacritty_terminal 0.26.0 are Apache-2.0; the transitive graph also includes other
permissive and MPL-2.0 licenses. The audit now explicitly rejects `terminal_view`.

```sh
O8_NEXT_TARGET=x86_64-unknown-linux-gnu O8_NEXT_LICENSE_OUTPUT=terminal-licenses.json node scripts/next/license-audit.mjs
O8_NEXT_LICENSE_OUTPUT=terminal-macos-licenses.json node scripts/next/license-audit.mjs
```

## Remaining limits and decision

The under-8-ms target is met only for local CPU scene acknowledgement. Echoed
input p95 is 24.685–26.339 ms and exceeds that target; the existing server batches
terminal output every 16 ms. GPU, compositor and physical-input timing remain
unmeasured in this headless environment.

The separate unpaced 50 MB saturation probe did not deliver every byte. Its
release red receipt was:

```text
assertion `left == right` failed: no silent terminal transport loss during flood
  left: 44301474
 right: 50000012
test result: FAILED. 2 passed; 1 failed
```

The fixture retains `burst` to reproduce unpaced saturation. Production terminal
`data` is intentionally lossy above the existing 64 KiB socket threshold; this
change does not alter that server policy. The repeatable 2.5 MB/s flood passes,
but unlimited-rate lossless delivery and the complete latency target remain open.
Use **Refs #4487**, not a closing keyword.
