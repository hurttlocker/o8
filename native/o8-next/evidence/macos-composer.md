# macOS release composer measurements

Refs #4462. Base: `dc4a2a14e` (merged #4466). macOS 26.6,
`x86_64-apple-darwin`, Rust 1.97.1, locked published `gpui` 0.2.2,
optimized release profile. No dependency or server protocol changes.

| Run | Composer key-to-scene ms | Send-to-first echo scene ms | Sidebar switch-to-content scene ms | Idle RSS MiB | Launch-to-content scene ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 1.53 | 74.29 | 7.45 | 45.10 | 425.20 |
| 2 | 1.52 | 76.53 | 8.68 | 45.00 | 400.09 |
| 3 | 1.44 | 70.33 | 8.15 | 45.25 | 430.89 |
| Median of runs | 1.52 | 74.29 | 8.15 | 45.10 | 425.20 |

Key and sidebar columns are within-run medians (20 keys and 10 switches).
The final row takes the median across the three run summaries. Echo, RSS and
launch have one observation per fresh process. Raw samples and the executable
SHA-256 are in [run 1](macos-composer/run-1.json),
[run 2](macos-composer/run-2.json) and [run 3](macos-composer/run-3.json).

## Endpoint and isolation

The runner is [scripts/next/macos-composer.ts](../../../scripts/next/macos-composer.ts).
Each run creates a new `dev-server.ts --composer` process. That host owns its
loopback HTTP/WebSocket sockets, temporary database, fixture Git repository and
saved histories. It imports the existing production middleware, queue handlers,
SQLite persistence, promotion/admission and history handlers. Only runtime
admission is a fixture acknowledgement; no provider is started. The native
process receives only that explicit origin and a fresh bearer. An inherited
DB-path sentinel stays unopened, and recorded requests are checked against the
existing fixture contracts. Every owned server is terminated and its data removed.

The native process uses `Application::headless()`, `show: false`, `focus: false`,
and window coordinates (-10000, -10000), with a 1200 by 816 viewport. The runner
rejects a composer benchmark without `--offscreen` and rejects mixed visible
benchmark modes before any window is opened. Native window-active checks before
and after the run remain false. A parent enforces a nine-second process cutoff.
No visible or focus-stealing window, OS synthetic input, installed application,
installed browser or installed application data is used.

The timing boundary matches the #4362/#4410 CPU scene harness: GPUI dispatch or
selection callback through two explicit `Window::draw` calls. A changed-content
paint callback must acknowledge the result. The first observed content scene
ends the launch clock, which starts at Rust `main` and includes application/window
creation and asynchronous session/history HTTP reads plus a 2 ms readiness poll.
It excludes server startup, executable loading, and process spawning. The raw `processDurationMs` field is Rust-main-to-receipt time and also excludes
loader and shutdown time. No cache clearing or machine-idle claim is made.

The key samples focus only GPUI's internal composer focus handle, dispatch actual
`a` keystrokes through `Window::dispatch_keystroke`, and require the exact edited
text and editor revision to reach paint. Sidebar samples call the same `select`
handler as a sidebar row, alternating the two composer fixtures, and include
history, queue and routing GETs through selected-session content paint. They do
not include pointer hit-testing. Send dispatches Enter and ends only after the
queue item is applied, the exact persisted operator text/id reaches the selected
transcript and that new row paints. Completed row identity/layout counts remain
unchanged. RSS samples only the native process after selection settles for 250 ms;
it excludes the fixture server. Startup initially selects the 100-row fixture tail;
composer and switch samples use the two one-row composer fixture sessions.

These are **CPU scene acknowledgements**, not displayed frames. Offscreen results
cannot represent GPU submission/execution, compositor scheduling/presentation,
vsync, display latency, physical input latency or visible native IME candidate
windows. No unattended on-screen run was performed.

## Web evidence comparison

The [#4362 WebKit table](https://github.com/o8-run/o8/blob/e53cd41b64739acc3a2f794557c20db8fd2b4fc1/spikes/gpuix-transcript/results/| Run | Composer key-to-scene ms | Send-to-first echo scene ms | Sidebar switch-to-content scene ms | Idle RSS MiB | Launch-to-content scene ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 1.53 | 74.29 | 7.45 | 45.10 | 425.20 |
| 2 | 1.52 | 76.53 | 8.68 | 45.00 | 400.09 |
| 3 | 1.44 | 70.33 | 8.15 | 45.25 | 430.89 |
| Median of runs | 1.52 | 74.29 | 8.15 | 45.10 | 425.20 |.md)
records isolated headless WebKit over a different 2,000-turn fixture. Key p50s are
26.50 / 28.00 / 25.00 ms (median 26.50); idle RSS is
493.65 / 491.90 / 488.70 MiB (median 491.90); launch is
2990.26 / 3948.00 / 2951.88 ms (median 2990.26). There is no recorded web
send-to-persisted-echo or sidebar-switch counterpart. Web keys include an input
update while streaming through two in-page animation frames; its memory scope
includes the browser host. Native samples here use the actual queue composer
without a concurrent provider stream, two CPU draws, a 100-message startup tail
and one-message composer fixtures. These observations do not establish a speed
ratio or production/web composer parity.

The prior [Linux debug results](sidebar-composer.md) are 8.732 ms key and 52.862 ms
send medians. They used `TestAppContext` and a different platform/profile, so they
are not a macOS before/after baseline.

## macOS defects and input checks

1. Cmd-Left/Right moved one grapheme; Cmd-Up/Down used ordinary vertical movement,
   and Cmd-Backspace deleted only one grapheme. The macOS platform modifier now
   moves to hard-line or document boundaries, extends selection with Shift, and
   deletes to the appropriate hard-line boundary. Undo/redo restores those edits.
2. A real queue send was persisted but displayed as an unconfirmed receipt because
   saved paths can use `/var` while the queue returns its canonical `/private/var`
   spelling. The client now compares canonical directory identity on a path
   mismatch. It retains exact request id, thread, POST payload and cancellation
   checks, rejects unrelated/missing repositories, and keeps the frozen retry body.
   The full Surface test checks the actual authenticated HTTP queue, persisted echo,
   retained rows and lost-response retry without duplicate messages. Independent
   read-only review found no blocking issue in this change.

Red receipts before fixes:

```text
Cmd-Left moves to the beginning of the current line
  left: 16..16
 right: 6..6
Message receipt did not match. Draft retained; inspect the shared queue.
```

The macOS GPUI tests exercise Japanese marked-text replacement/commit at a
nonzero UTF-16 offset, emoji composition and grapheme deletion, IME undo as one
edit, CRLF/CR multiline paste, selection, Cmd-A/C/X/V/Z/Shift-Z,
Cmd-arrow/Shift-arrow navigation, Cmd-Backspace, Shift-Enter, Cmd-Enter and
Cmd-Shift-Enter. Submit/mode changes are suppressed while marked text exists.
Clipboard tests use GPUI's test clipboard, not the system clipboard. Composition
calls the production `EntityInputHandler` contract in process; it does not open an
OS input source or candidate panel.

## Verification

- Release native tests: **12 passed**, including two macOS input tests and the
  symlink receipt regression. Both defects have a failing receipt before the fix.
- Focused web/API/provenance tests: **5 files, 60 passed**. This includes the
  transcript/sidebar and stream render-tree comparisons, durable composer queue,
  real queue paths and the previously failing provenance check.
- TypeScript (8 GiB heap), touched-file ESLint, Rust format, test classification,
  and rule check against `dc4a2a14e`: passed.
- Actual CLI → native → owned HTTP → hidden GPUI content paint: passed.
- Three release composer runs: 20 acknowledged edits, 10 session switches, one
  exact persisted echo and zero completed-row re-layouts each. Every native
  run reached its receipt within 0.9 seconds of Rust main, without activation;
  the parent bounds full process lifetime to nine seconds.
- Full hermetic `npm test`: **1,208 files / 8,560 tests passed**, three files /
  four tests skipped; 578.59 seconds. Its first run had 8,559 passes,
  four skipped tests and one `spawnSync git ENOBUFS` failure. Preserved generated
  spike cache files made `git status --untracked-files=all` exceed the test's
  default subprocess buffer. The same test passes with a process-local Git
  exclude for `/spikes/`; no cache files or Git configuration were changed.
  The successful full rerun used that temporary exclusion and omitted no tests.


Reproduce from the repository root on macOS:

```sh
cargo +1.97.1 build --manifest-path native/o8-next/Cargo.toml --release --locked
O8_NEXT_BINARY="$PWD/native/o8-next/target/release/o8-next" node --import ./scripts/register-server-only-stub.mjs --import tsx scripts/next/macos-composer.ts
cargo +1.97.1 test --manifest-path native/o8-next/Cargo.toml --release --locked
```

The [macOS license graph](macos-composer/licenses.json) contains 451 normal/build
packages, zero GPL packages and no excluded application crates. Application UI
remains original Apache-2.0 Rust using the published GPUI crate. The opt-in surface
is suitable for continued review with the native path/input defects fixed. These
fixture CPU measurements do not authorize replacing the shipped surface.
