# App shell fixture evidence (#4548)

Baseline: `40c8ab24e` on main, which includes the workspace grid. Terminal PR
#4502 and diff PR #4539 remained unmerged during this work. This shell does not
copy their implementations or import their crates. It reports those commands as
unavailable, so #4548 remains open.

## Real entry points

- `tests/o8-next-shell-real-path.test.ts` builds and executes `cli/dist/o8.mjs`.
  Its disposable server is the README dev-server pattern with production
  middleware and production list/history/context/inventory/queue handlers.
  The fixture writes its own local `api-port` and `ws-token` files. A small
  child-process probe substitutes only for the native executable at the launcher
  seam and authenticates the actual HTTP route. Credentials never enter argv,
  receipts or view-state JSON. Worker-only, mixed worker/native and explicit
  foreign-origin cases cross the same middleware.
- `native/o8-next/src/shell_tests.rs` opens the production shell window under
  GPUI TestAppContext and reads persisted fixture sessions over HTTP. Tests
  dispatch palette/grid/session keys and workspace mouse clicks, acknowledge
  content CPU paint, close and reopen the window through the production window
  factory, and verify bounds, surfaces, sidebar selection and composer focus.
  They verify the existing grid's own persisted slots and leave Ctrl+Alt+W to
  its selected pane. Sidebar selection retains the original Surface entity and
  its drafts. Terminal and diff commands expose their unavailable state.
- `native/o8-next/tests/shell_cli.rs` executes the actual native binary. It
  verifies opt-in/absolute-state arguments and rejects malformed or oversized
  persisted state while retaining the original bytes.

The fixture replaces runtime discovery/admission only. No operator session,
provider, account, Tauri app or display is used. The shipped Tauri app and
release/version/deploy/publishing inputs are unchanged.

## Red receipts

Written and run before their fixes:

```text
FAIL tests/o8-next-shell-real-path.test.ts
invalid_args: Pass --enable-next, --binary with an absolute executable path, and --server.
Test Files 1 failed (1)
Tests 1 failed | 1 passed (2)

shell_palette_switch_restart_and_server_down ... FAILED
assertion failed: restarted.read_with(restart_cx, |s, _| s.current().unwrap().composer)
test result: FAILED. 0 passed; 1 failed

shell_retains_sidebar_selection_and_view_identity ... FAILED
changing the session in the sidebar must retain the existing Surface and its drafts
left: EntityId(2v1)
right: EntityId(5v1)
test result: FAILED. 0 passed; 1 failed

FAIL tests/o8-next-shell-real-path.test.ts > does not upgrade a mixed worker and native environment to operator authority
expected 200 to be 401
Test Files 1 failed (1)
Tests 1 failed | 3 skipped (4)

shell_palette_switch_restart_and_server_down ... FAILED
the grid close-pane shortcut must keep its enclosing shell surface open
left: Some(Session("thoughts-long"))
right: Some(Grid)
test result: FAILED. 0 passed; 1 failed
```

The last receipt explicitly reproduces the original broad Ctrl+W capture after
adding the grid assertion. Narrowing the shell shortcut restores grid dispatch.
Independent read-only review found the mixed-token and grid-shortcut cases and
reported no remaining blockers after their fixes.

## Green receipts

```text
Focused TypeScript: Test Files 4 passed (4); Tests 17 passed (17)
Final launcher regression: Test Files 1 passed (1); Tests 5 passed (5)
Native release: test result: ok. 16 passed; 0 failed; 2 ignored
Native executable tests: 2 passed; 0 failed (pane_grid_cli.rs)
Native executable tests: 2 passed; 0 failed (shell_cli.rs)
Each of three explicit shell measurement runs: 1 passed; 0 failed
npm test: Test Files 1222 passed | 3 skipped (1225)
Tests 8675 passed | 4 skipped (8679); Duration 687.08s
```

`tsc`, `typecheck:fast`, touched-file ESLint, rule-check (3 eligible files),
classification, Rust formatting, normal release build and the existing
protocol-only runner pass. The two ignored Rust cases are existing explicit
transcript/grid measurement workloads. The shell measurement was run explicitly.

Merge-tree simulations add no new conflicts beyond each open terminal/diff
branch's conflicts against main. The terminal baseline conflicts are the shared
fixture host and generated test classification. The diff baseline additionally
conflicts in its README and main entry point. These branches still need their
existing integration/rebase work when combined.

Commands (Node 22, stable Rust, Linux; normal JavaScript dependencies installed):

```sh
NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit
npm run typecheck:fast
npx vitest run tests/o8-next-shell-real-path.test.ts tests/next-render-parity.test.ts tests/next-stream-parity.test.ts tests/o8-next-pane-grid-real-path.test.ts
npx eslint cli/src/commands/next.ts scripts/next/dev-server.ts scripts/next/shell-fixture.ts tests/o8-next-shell-real-path.test.ts
npm run rule-check -- --base=40c8ab24e
node scripts/classify-tests.mjs --check
cargo fmt --manifest-path native/o8-next/Cargo.toml -- --check
cargo test --release --locked --manifest-path native/o8-next/Cargo.toml -- --nocapture --test-threads=1
cargo build --release --locked --manifest-path native/o8-next/Cargo.toml
O8_NEXT_TARGET=x86_64-unknown-linux-gnu O8_NEXT_LICENSE_OUTPUT=work/licenses-linux.json node scripts/next/license-audit.mjs
O8_NEXT_TARGET=x86_64-apple-darwin O8_NEXT_LICENSE_OUTPUT=work/licenses-macos.json node scripts/next/license-audit.mjs
npm test
```

The cloud image needed stable Rust and local linker symlinks to its installed
`libxcb.so.1`, `libxkbcommon.so.0` and `libxkbcommon-x11.so.0`; no source or
manifest changes were needed for that setup. The normal/build license audit
passed for **460 Linux / 443 macOS packages**, with zero GPL or excluded
application crates. No dependencies were added.

## Measurements

Three fresh optimized, sequential invocations of the existing headless test:

```sh
cargo test --release --locked --manifest-path native/o8-next/Cargo.toml shell_palette_switch_restart_and_server_down -- --nocapture --test-threads=1
```

Raw samples: [run 1](run-1.json), [run 2](run-2.json), [run 3](run-3.json).

| Run | Shell creation to content CPU paint (ms) | Palette open-to-frame p95 (ms) | Workspace click-to-content p95 (ms) | Idle RSS (MiB) |
| --- | ---: | ---: | ---: | ---: |
| 1 | 115.201 | 3.906 | 10.796 | 14.734 |
| 2 | 108.868 | 2.503 | 8.795 | 15.141 |
| 3 | 113.910 | 2.671 | 14.886 | 14.852 |
| Median | 113.910 | 2.671 | 10.796 | 14.852 |

Timer boundaries:

- Shell startup begins immediately before the shared production window factory
  and ends after the selected HTTP history reaches an acknowledged content CPU
  scene. Fixture-host startup and native process startup are excluded.
- Each of 20 palette samples begins before Ctrl+K dispatch and ends after the
  scene paint callback acknowledges the new shell revision. The test executor
  and two explicit refresh/draw calls are included.
- Each of 10 alternating workspace switches begins immediately before the mouse
  click and ends after selected content CPU paint. The first switch loads a
  second workspace; later switches reuse retained views.
- RSS is sampled from the native test process after switching settles, with
  three surfaces retained across two workspaces, before closing the window.
  It excludes the separate Node fixture server. This is one sample per run.

These are CPU scene measurements with GPUI's test text system. They establish
neither native-font shaping nor GPU/compositor/physical-input latency. There was
no shell on main for a before-performance comparison. Behavior counts changed:
**0 -> 1 shell entry point**, **0 -> 2 fixture workspaces**, **0 -> 3 persisted
surfaces**, and the mixed-authority regression changed **HTTP 200 -> HTTP 401**.

## Remaining acceptance

- Open a packet diff and attach a terminal from the palette after their surface
  PRs land. Current commands report unavailable and do not create fake tabs.
- Measure complete native-process launch to interactive on a supported display.
  The headless shell-creation envelope above is recorded separately.
- Native-font/GPU/compositor timing and compact/wide on-screen acceptance remain
  unverified in this Linux cloud environment.

Refs #4548
