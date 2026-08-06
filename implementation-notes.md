# Windows Node runtime locator (#1740, part of #1673)

## Problem

`run_node_preflight()` in `src-tauri/src/lib.rs` only ever resolved `node`
via POSIX login shells (`resolve_node_via_login_shell()`: zsh → bash → sh →
`which`) and `find_preferred_node_22()` (globs `$HOME/.nvm`, `.fnm`,
`.volta`, Homebrew paths). None of that exists on Windows — `probe_login_shell()`
and both of the above always return `None` there, so a Windows install with
Node 22 correctly on PATH would still hit `NodePreflightError::Missing` when
launched from Explorer (no inherited terminal PATH, mirroring the macOS
Finder-launch problem this whole subsystem exists to solve).

## Change

- New module `src-tauri/src/windows_node_locate.rs`: `resolve_node_via_where()`
  (`where node`) plus `find_preferred_node_22()` scanning the official
  installer / winget / choco fixed paths and the nvm-windows / Volta / fnm
  version-manager roots. Root selection + version matching are pure,
  env-injectable functions (`candidate_roots`, `find_preferred_node_22_via`)
  with unit tests that run on any host via `cargo test --lib` — the module
  declaration is `#[cfg(any(test, target_os = "windows"))]` so it compiles
  in test builds everywhere but ships zero bytes/warnings on normal macOS
  builds.
- `run_node_preflight()` gained a `.or_else(resolve_node_windows)` step —
  `resolve_node_windows()` is `cfg(windows)` → tries the new module;
  `cfg(not(windows))` → `None` (byte-identical macOS/Linux behavior).
- `augment_process_path()`: PATH was always split/joined on `:`, which
  silently corrupts a real Windows (`;`-delimited) PATH when forwarding it to
  spawned children (Next server, ws-server, MCP, dispatched workers). Now
  uses `;` on Windows, `:` elsewhere (`cfg!(windows)` is a compile-time
  constant, so macOS behavior is unchanged). Also fixed the adjacent log
  line, which re-split the now-`;`-joined string on `:` purely for a count —
  it now counts the pre-join Vec directly.
- `cli_locate::well_known_cli_bin_dirs()` gained a `cfg(windows)` block for
  the same version-manager dirs (nvm-windows/Volta/fnm), used by
  `augment_process_path` to widen the PATH other dispatched CLIs (claude,
  codex, gemini, gh) get found on.
- `show_node_error_and_exit()`: extracted the "how to install Node" text into
  `node_install_hint()`, cfg-split so the Windows dialog body points at
  nodejs.org / winget / nvm-windows instead of brew/nvm. Delivery mechanism
  (mshta) was already Windows-gated and unchanged. Left
  `NodePreflightError::UnsupportedNativeAbi`'s body as-is (rare path, already
  names a specific major to install — see Deviations).
- `docs/internals/port-audit-windows.md`: appended a short "Update (#1740)"
  note under the existing Node-discovery finding; did not touch structure or
  other sections.

## Verification

- `cargo check --lib` (macOS): clean.
- `cargo test --lib`: existing `node_preflight_tests` (macOS) unaffected;
  new `windows_node_locate::tests` (4 cases: nvm-windows layout, fnm
  layout, non-22 version rejection, fixed-root check) pass on macOS via the
  `cfg(any(test, target_os = "windows"))` module gate.
- No Windows machine available — the Windows-only code paths
  (`resolve_node_via_where`, `find_preferred_node_22` wrapper,
  `well_known_cli_bin_dirs`'s windows block) are `cfg(windows)`-gated and
  were not exercised locally; they'll compile-check on `windows-latest` CI.
  Confidence is based on std-only APIs (`Command`, `PathBuf`, `env::var`) and
  documented nvm-windows/Volta/fnm/choco directory layouts.
- `npx tsc --noEmit`: no TS files touched by this packet; not expected to be
  affected, ran anyway per protocol.

## Deviations

- Left `NodePreflightError::UnsupportedNativeAbi`'s dialog body pointing at
  brew/nvm command syntax even on Windows. That branch is a narrow edge case
  (found Node's major isn't 22 or 24) whose message already names a specific
  required major and an `nvm alias default` tip that doesn't map cleanly to
  a shared generic hint. The mshta dialog still renders correctly on
  Windows; only the suggested install command reads slightly off-brand. Not
  part of the "missing/too old" acceptance criteria this issue calls out.
- Did not touch `src/lib/mcp/operator-node22-locator.ts` (the MCP re-exec
  locator flagged in the audit doc) or Node bundling — out of scope per the
  task's Rust-side framing (`src-tauri/src/lib.rs` + `src-tauri/src/cli_locate.rs`).
- Did not fix `cli_locate::scan_for_binary()`'s `:`-only PATH split — it's
  only reachable from `#[cfg(target_os = "macos")] mod agent` today (verified
  via grep), so it has no live Windows code path yet and touching it would be
  unrelated scope creep for this issue.
