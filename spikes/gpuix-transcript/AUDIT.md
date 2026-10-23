# Current execution status

The blocked receipt below is historical. The preceding work completed a release
addon build from the unchanged source pins, using Rust 1.97.1 and the available
Metal toolchain. The source checkout has no diff. This continuation installed
only the spike-local Playwright dependency and its isolated WebKit runtime; it
did not acquire native toolchains or change saved defaults. The cached addon
SHA-256 is recorded in source-pins.json. It is a local x86_64 build, not a
published package for that target. Rebuild from the pinned sources with:

```sh
cargo +1.97.1 build --locked --offline --release --features test-support --target x86_64-apple-darwin
```

Run from the source checkout's packages/native directory after source/dependency
audit and prerequisites. Copy the resulting dynamic library to the isolated
@gpuix/native package using its expected napi filename. The previous build log
reported release completion in 8m15s. Fresh measurements now use the isolated
method in [METHOD.md](METHOD.md). Prior desktop probes are excluded. Product
components and root dependencies remain unchanged. No merge or release occurred.

# Source audit receipt (historical pre-build state)

Status: stopped before dependency installation or compilation, 2026-10-23.
This is a blocked research handoff, not a completed benchmark. No fixture,
native application, preview route, measurement script or screenshot was made.
Only this spike directory changed. The root dependency installation was untouched.

## Exact inputs

See [source-pins.json](source-pins.json). The repository was cloned under the
ignored `vendor/gpuix/` directory at tag `@gpuix/native@0.11.0`, commit
`2e31b47ff6432ceebe70e7fc7b0f51a76d7d30cf`. Its submodule was checked out at
`f77e5cfe9dad04288566f00c66ecf3c58d6f84b3`. Both fetches used GitHub.

The npm registry reports version `0.11.0` and tarball
`https://registry.npmjs.org/@gpuix/native/-/native-0.11.0.tgz`.
The native package's published target list excludes `x86_64-apple-darwin`.
The React adapter and native package both declare version `0.11.0`.
No npm graph was installed; the package.json here is an empty, private scaffold.
All future installs and generated files must remain inside this spike directory.

## Stop condition and source trace

1. The native package build runs two release-mode `napi build` commands with
   `test-support`, then TypeScript compilation. Its `build.rs` only calls
   `napi_build::setup()`. The native Cargo manifest links local GPUI crates,
   `gpui_macos` and `gpui_terminal`.
2. `gpui_macos` depends on `gpui_apple`. The latter's build script selects offline
   shader compilation unless `runtime_shaders` is enabled. The default native
   package build does not enable that feature. It runs `xcrun ... metal` and
   `xcrun ... metallib`.
3. `xcrun metal --version` exited 1 with:

   ```text
   cannot execute tool 'metal' due to missing Metal Toolchain;
   use: xcodebuild -downloadComponent MetalToolchain
   ```

   The pinned upstream macOS CI explicitly runs that download command. This
   Apple component is outside crates.io, npm and GitHub sources. The download
   command was NOT executed. An explicit source exception is required to use it.
4. Both Rust toolchain files pin `1.97.1`. `rustup toolchain list` showed only
   the stable toolchain; `rustc --version` reported `1.94.0`. The required version
   is not installed. Invoking Cargo in the clone could trigger rustup's toolchain
   acquisition; no Cargo command was run there. Do not silently substitute stable.

Pinned source evidence:

- [Native scripts and targets](https://github.com/remorses/gpuix/blob/2e31b47ff6432ceebe70e7fc7b0f51a76d7d30cf/packages/native/package.json#L48-L85).
- [Native Cargo manifest](https://github.com/remorses/gpuix/blob/2e31b47ff6432ceebe70e7fc7b0f51a76d7d30cf/packages/native/Cargo.toml).
- [Native build script](https://github.com/remorses/gpuix/blob/2e31b47ff6432ceebe70e7fc7b0f51a76d7d30cf/packages/native/build.rs).
- [Terminal Cargo manifest](https://github.com/remorses/gpuix/blob/2e31b47ff6432ceebe70e7fc7b0f51a76d7d30cf/packages/gpui-terminal/Cargo.toml).
- [Metal download in upstream CI](https://github.com/remorses/gpuix/blob/2e31b47ff6432ceebe70e7fc7b0f51a76d7d30cf/.github/workflows/ci.yml#L75-L80).
- [Rust toolchain pin](https://github.com/remorses/gpuix/blob/2e31b47ff6432ceebe70e7fc7b0f51a76d7d30cf/rust-toolchain.toml).
- [macOS manifest](https://github.com/remorses/zed/blob/f77e5cfe9dad04288566f00c66ecf3c58d6f84b3/crates/gpui_macos/Cargo.toml).
- [Metal build path](https://github.com/remorses/zed/blob/f77e5cfe9dad04288566f00c66ecf3c58d6f84b3/crates/gpui_apple/build.rs#L17-L24).
- [Compiler invocation](https://github.com/remorses/zed/blob/f77e5cfe9dad04288566f00c66ecf3c58d6f84b3/crates/gpui_apple/build.rs#L123-L172).

The Cargo lock sources inspected were crates.io and exact GitHub revisions.
This does NOT clear the full transitive build-script download audit: it stopped
at the toolchain boundary before fetching dependencies. Resume that audit first.
The upstream `runtime_shaders` feature is a possible future alternative to offline
Metal compilation; it was not enabled or evaluated after the stop condition.

## Static compatibility findings

The pinned [README contract](https://github.com/remorses/gpuix/blob/2e31b47ff6432ceebe70e7fc7b0f51a76d7d30cf/README.md)
documents unsupported nested vertical scrolling, lack of text-colour inheritance,
unsupported WOFF/WOFF2, and absent spring/keyframe/variant/shared-layout animation.
These are documented constraints, not observed application failures. TTF/OTF
registration, horizontal child scrolling, numeric tweens and variable-height
virtual lists are documented. Native list virtualization alone retains all React
rows; the app must use `itemCount`/`windowStart` for React windowing.

The current o8 transcript entry point is
[`WorkspaceTranscript.tsx`](../../src/components/desktop/workspace-terminal/WorkspaceTranscript.tsx).
Its [development preview](../../src/app/preview/worker-transcript/page.tsx) shows
the integration pattern. It maps grouped activity and messages; a fair baseline
must preserve its current production behavior, not replace it with a mock.

Initial terminal discovery checked PATH, system/user Applications folders, and
Spotlight bundle identifiers `net.kovidgoyal.kitty` and `com.mitchellh.ghostty`;
no match. That initial absence is superseded by the follow-up below.

## Terminal follow-up

Ghostty is now installed. Its app metadata and `ghostty +version` both report
`1.3.1`; the executable contains an `x86_64` slice. No installation was performed
by this spike. The operator requires a terminal comparison using
`GPUIX_TERMINAL=1`, a screenshot, equivalent frame/RSS measurements, and closure
of only the windows opened for this experiment.

The pinned README's "Run in a terminal" section says this uses the same React
tree, GPUI layout, text and GPU paint with an offscreen Metal surface on macOS.
The native renderer selects its terminal backend from `GPUIX_TERMINAL=1`.
It still requires the native addon, and none has been built or found in the
vendor checkout. Ghostty alone does not remove the toolchain blockers.

Rechecking `xcrun metal --version` returned the same missing-toolchain error.
Rustup still lists only stable and `rustc --version` remains `1.94.0`.
Terminal mode is now blocked pending build, not skipped for terminal absence.
All three surfaces have zero runs. No Ghostty window was opened or closed,
and no transcript screenshot exists. [METHOD.md](METHOD.md) records the terminal
measurement and window ownership requirements.

## Shortest unblock

Explicitly authorize the necessary Apple and Rust toolchain source exceptions,
or supply already-installed approved toolchains. Then finish dependency audit,
install an exact locked graph locally, and implement the pending benchmark.
This receipt does not authorize installation, a feature substitution, or a merge.
