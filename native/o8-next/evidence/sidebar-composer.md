# Sidebar and composer verification

Base: `d62ab4d1e` from `origin/main`, including the live transcript work in #4429.
Only the explicit `o8 next` binary/launcher changes. Tauri defaults, release,
version, deployment and publishing configuration are unchanged.

## Red receipts

The test was written before the implementation and invoked the actual native
executable through `scripts/next/verify.ts` against the owned fixture host:

```text
{"error":"Unknown argument; use --help"}
--sidebar-tree: exit 1
```

The GPUI real-path test also exposed a legacy-session regression before its fix:

```text
legacy history remains readable without composer routing
  left: 0
 right: 1
test result: FAILED. 0 passed; 1 failed
```

Integration with the live transcript additionally caught an HTTP echo discarding
the earlier agent row. The corrected path inserts missing persisted operator
entries without replacing streamed agents or advancing the WebSocket sequence.
The real-path test checks retained row identity, unchanged layout count and an
unchanged nonzero stream sequence after sending.

An explicit HTTP rejection originally retained an invalid request identity:

```text
first HTTP rejection retires only the unaccepted identity
test result: FAILED. 0 passed; 1 failed
```

The fix retires only a first, definite 4xx nonacceptance. A lost response still
retains the original id/routing, including when a later retry is rejected.

## Green receipts

```text
test result: ok. 9 passed; 0 failed; 0 ignored
Test Files  4 passed (4)
     Tests  45 passed (45)
Test Files  1207 passed | 3 skipped (1210)
     Tests  8541 passed | 4 skipped (8545)
[rule-check] OK — scanned 4 file(s), zero violations vs origin/main
Audited 460 packages, no GPL or excluded application crates
```

| Check | Result |
| --- | --- |
| `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit` | Exit 0 |
| ESLint on every touched TS/MJS file | Exit 0 |
| Rule check against `origin/main`, owned temporary data directory | Exit 0; four supported production TS files scanned |
| `cargo test --locked --manifest-path native/o8-next/Cargo.toml` | Nine passed |
| `cargo build --locked` and Rust format check | Passed |
| Focused web/API tests | Four files, 45 passed |
| Full `npm test`, run once on the integrated checkout | 1,207 files / 8,541 tests passed; 3 files / 4 tests skipped; 346.58 s |
| Test classification manifest | Matches |
| CLI bundle and native protocol-only runner | Passed |
| License audit, Linux normal/build graph | 460 packages; pure Apache-2.0 `gpui` UI; no GPL or excluded application crates |
| Independent local-HTTP/authentication source review | Resolved owned-publication-sink and exact-denial evidence findings |

Focused files:

- `tests/next-render-parity.test.ts`
- `tests/next-stream-parity.test.ts`
- `tests/composer-queue-real-path.test.ts`
- `src/components/desktop/thoughts/chat-panel/durable-composer-queue.test.ts`
- `native/o8-next/src/input_tests.rs`
- `native/o8-next/src/surface_tests.rs`

The native protocol entry points match ten sidebar fixture sessions in three
groups and all existing recorded transcript trees (100, 6 and 4 render rows).
Order, grouping and selection mutations are detected by the web checks.
The headless GPUI tests cover IME confirmation/replacement at a nonzero UTF-16
offset, multiline paste, long-input caret reachability, selection, cut and undo.
The send path crosses production middleware, HTTP queue handlers, SQLite,
promotion/admission and persisted transcript reads. It checks exact anonymous and
invalid-bearer HTTP 401 responses. Only runtime admission is a fixture
acknowledgement; publication is confined to an owned loopback sink.

| Observable | Before | After |
| --- | ---: | ---: |
| Requested grouped native sidebar | Unavailable | 10 sessions, 3 groups |
| Native Rust tests on the current main base | 5 | 9 |
| Legacy history without composer routing, regression test | 0 visible rows | 1 visible row, sending disabled |
| First operator send, durable records | 0 | 1 |
| Selected-session transcript after admitted echo | 1 row | 2 rows |
| Persisted message copies after lost-response retry | 1 | 1 |
| Completed-row additional layouts for send echo | 0 | 0 |

Linux needed the compatible libc 0.2.183 / nix 0.31.2 lockfile resolution: the
newer libc removed `ENOATTR`, still referenced by GPUI's existing xattr dependency.
GPUI test-support adds its published platform/test dependencies; no UI crate from
the Zed application was introduced. Node 22 was selected explicitly in the
Cloud checkout. Tests used owned state, fixture repositories and no accounts.

## Measurements and limitations

Three fresh test processes, each with an owned fixture HTTP host, in the debug
profile. Twenty actual composer keystrokes per run reach the editor's CPU paint
callback. Each sample uses the scene-draw endpoint from the existing evidence
harness, through GPUI `TestAppContext`. Send-to-first-echo includes queue POST,
fixture admission, persisted queue/history GETs and the resulting GPUI draw.

| Run | Key-to-CPU-scene median ms | Send-to-first persisted echo ms |
| --- | ---: | ---: |
| 1 | 8.156 | 52.862 |
| 2 | 8.732 | 49.282 |
| 3 | 8.778 | 58.832 |
| Median of runs | 8.732 | 52.862 |

Raw samples: `composer/run-1.json`, `composer/run-2.json`, `composer/run-3.json`.
No comparable composer existed before this change. These debug/TestAppContext
numbers are not comparable to prior release/macOS measurements and do not
measure provider inference, OS input, GPU submission, presentation or photons.
No machine-idle claim is made.

The real CLI → native `--offscreen` window harness was attempted and stopped at:

```text
GPUI window: neither DISPLAY nor WAYLAND_DISPLAY is set. You can run in headless mode
```

Published GPUI's Linux `Application::headless()` cannot open that window on this
host. The actual native protocol/render-tree runner passes with `--protocol-only`,
and the GPUI test context runs without a display. Standalone window, GPU,
compositor and on-screen visual measurements remain unavailable here. No OS-level
synthetic input or operator-machine access was used.
