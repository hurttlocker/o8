# Real worker composer verification (#4532)

The native composer uses the WebKit composer's existing durable queue API:
POST saves the frozen send/steer intent, PATCH promotes an existing queued id,
and DELETE removes a cancellable record. The production queue heartbeat admits
the message to the selected session. No application route, shipped Tauri code,
dependency, release, version or publishing file changes.

The previous fixture acknowledged `liveSteer` without running a worker. The new
`dev-server.ts --composer --worker` mode hosts production HTTP handlers and the
real `src/ws-server.ts` entry point. A real Pi SDK child runs the selected session;
only inference and external tool servers are fixtures. Runtime discovery is
fenced to the owned disposable store. No accounts or provider calls are used.
The fixture releases its model response through stdin, outside the app protocol.

The production sync cursor excludes its last message id. Consequently, changing
the text of that same assistant id did not refresh the native transcript. The
existing one-second native reconciliation tick now reads the saved tail. It
retains older rows and rejects responses overtaken by a WebSocket sequence,
boot change, newer reconciliation request, session selection or send mutation.
HTTP refreshes never advance the WebSocket sequence fence.

## Red before the fix

`tests/composer-next-worker-real-path.test.ts` was written and run first against
the existing dev-server entry point:

```text
AssertionError: an idle send must start a real fixture worker and persist its streamed reply: expected false to be true
Test Files  1 failed (1)
     Tests  1 failed (1)
```

The headless composer regression was also run before changing the native UI:

```text
render the default mode in words
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 10 filtered out
```

After real worker admission worked, the same native path exposed the mutable-id
streaming failure before saved-tail reconciliation was implemented:

```text
fixture timed out: advancing worker stream
test result: FAILED. 10 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out
```

## Green verification

```text
Test Files  4 passed (4)
     Tests  26 passed (26)
test result: ok. 12 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
```

The server fixture was rerun after adding its discovery fence: 1 file / 1 test
passed. The three measurement runs each pass the native workflow separately.

Tests:

- `tests/composer-next-worker-real-path.test.ts`: production HTTP middleware,
  queue handlers, WebSocket server, heartbeat, Pi SDK process and persisted
  history. Verifies idle send, live steer, deferred queue, promotion, removal,
  rejection of removing an admitted turn, worker responses, WS delivery and
  retry deduplication.
- `native/o8-next/src/worker_tests.rs`: real GPUI typing/Enter, both rendered
  mode sentences, queue controls, real worker results, deferred delivery,
  removal retaining an unsent draft, and input/content paint acknowledgements.
- `native/o8-next/src/stream.rs`: saved-tail refresh retains earlier context and
  refuses stale responses after newer WebSocket history or a boot change.
- `native/o8-next/src/surface_tests.rs`: existing composer/session/echo/retry
  workflow, extended to reject unauthenticated DELETE as well as POST/PATCH.
- `tests/next-render-parity.test.ts`, `tests/next-stream-parity.test.ts` and
  `tests/composer-queue-real-path.test.ts`: existing renderer, stream and durable
  queue regressions.

`NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit`, ESLint on the four
touched TypeScript files, changed-file rule check, test classification, Rust
formatting and `git diff --check` pass. The crate's Linux normal/build dependency
license audit passes: **460 packages, zero GPL or excluded application crates**.

Full `npm test`, run once at completion:

```text
Test Files  1218 passed | 3 skipped (1221)
     Tests  8619 passed | 4 skipped (8623)
Duration  294.18s
```

Three-way file merges of every overlapping changed file with the current heads
of PRs #4500 and #4502 are clean. This checks source merge compatibility; it does
not claim their combined runtime suites were executed. The worker fixture also
exposes the existing production inventory GET with discovery fenced empty for
the adjacent transcript client's session list.

| Observable behavior | Before | After |
| --- | --- | --- |
| Modes verified against a running fixture worker | 0 | 3: send, steer, queue |
| Explicit mode sentences | 0 | 2 |
| Queue row actions | Steer now | Steer now, Remove |
| Mutable assistant id | Cursor stops after first update | Saved tail refreshed each second |
| New server regression | 1 failing | 1 passing |
| New native workflow regression | 1 failing | 1 passing |

## Measurement boundaries and commands

Linux, Node 22.23.4, Rust stable 1.99.1, optimized Cargo tests. Each sequential
run owns a fresh server, workspace, database and Pi session. The fixture model
streams at 20 Hz; the native full-tail reconciliation runs once per second.
Each of 30 key samples waits for changed worker text before dispatching the next
key. The actual composer revision must reach its CPU paint callback. Enter to
first worker transcript paint includes queue HTTP, production heartbeat admission,
Pi startup, history reconciliation and content paint; an operator echo alone
cannot finish that timer. Host startup and initial session selection are excluded.

TestAppContext uses a no-op text system. These are CPU scene acknowledgements,
not GPU/compositor presentation or physical input measurements. There was no
working-worker measurement baseline; these numbers claim no before/after speedup.
The multi-second send latency includes the existing five-second queue heartbeat.
The issue specifies no numeric latency threshold.

```sh
npx vitest run tests/composer-next-worker-real-path.test.ts tests/next-render-parity.test.ts tests/next-stream-parity.test.ts tests/composer-queue-real-path.test.ts
cargo test --release --locked --manifest-path native/o8-next/Cargo.toml -- --nocapture
O8_NEXT_WORKER_RESULTS=native/o8-next/evidence/worker-composer/run-1.json cargo test --release --locked --manifest-path native/o8-next/Cargo.toml worker_send_steer_queue_promote_remove_and_streaming_latency -- --nocapture
NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit
npx eslint scripts/next/dev-server.ts scripts/next/worker-server.ts scripts/next/worker-runtime.ts tests/composer-next-worker-real-path.test.ts
npm run rule-check -- --base=2a623b195
node scripts/classify-tests.mjs --check
O8_NEXT_TARGET=x86_64-unknown-linux-gnu O8_NEXT_LICENSE_OUTPUT=work/worker-licenses.json node scripts/next/license-audit.mjs
npm test
```

Repeat the measurement command with `run-2.json` and `run-3.json`. Percentiles use
nearest rank: sorted sample at `ceil(p * sampleCount) - 1`. Raw receipts:
[run 1](worker-composer/run-1.json), [run 2](worker-composer/run-2.json),
[run 3](worker-composer/run-3.json).

| Run | Key → CPU scene p50 ms | Key → CPU scene p95 ms | Enter → first worker transcript paint ms | Streaming text bytes before → after |
| --- | ---: | ---: | ---: | ---: |
| 1 | 0.581 | 0.898 | 6041.320 | 26 → 2304 |
| 2 | 0.543 | 0.744 | 6012.317 | 30 → 2324 |
| 3 | 0.552 | 1.080 | 6054.166 | 22 → 2296 |
