# macOS release package compression

Use the normal approved release workflow from the clean, tagged release checkout.
On macOS, set the system `tar` writer's gzip compression level for that command:

```sh
TAR_WRITER_OPTIONS=gzip:compression-level=9 npm run ship
```

The macOS `tar` manual documents `TAR_WRITER_OPTIONS` as the default options for
format and compression writers, and gzip compression levels from 1 through 9.
This command uses level 9 only within the release process and its children.

The [package size preflight](../../scripts/lib/mac-package-size.mjs) creates a
fresh archive with this setting. The [signing and notarization
entry point](../../scripts/sign-and-notarize.mjs) uses it again when packaging the
final signed and stapled app. Both retain `COPYFILE_DISABLE=1` to exclude
AppleDouble metadata that the updater cannot extract.

The bundle files, tar format and updater extraction path stay the same. The
existing checks still require full bundle-content equality, universal binaries,
valid signatures, notarization and the unchanged [footprint
ceilings](../../scripts/lib/footprint-budget.mjs). The final signed and stapled
archive must pass its size check before publication. An archive measured before
notarization supplies only a packaging diagnostic.

For an approved [remote app handoff](./remote-release-build.md), include the same
task-local setting alongside `O8_RELEASE_APP_HANDOFF`. The normal handoff identity
and import checks still apply.

## CPU-specific packages in development

CPU delivery is off by default. [#3646](https://github.com/hurttlocker/o8/issues/3646)
tracks signed-package and installed update acceptance on Intel and Apple Silicon.
Do not enable this mode for a release until both acceptance records exist.

Both CPU apps come from the same final universal app. Only the four native
executables are thinned. A derivation receipt binds the source bundle; comparison
checks preserve executable payloads, shared runtime files, modes and relative
links. Existing Node 22/24 and x64/arm64 addon prebuilds remain in both apps.
Preparation refuses existing output and retains failed staging for inspection.

For an unsigned development preparation in a release checkout:

```sh
node scripts/macos-cpu-packages.mjs
```

The output is under the universal bundle's `cpu/x86_64` and `cpu/arm64`
directories. It is not an installer or accepted release. Preparation does not
change the universal app, start a server or launch a model.

After installed acceptance and a separately approved release, the normal ship
entry point can build all three distributions:

```sh
O8_MACOS_CPU_PACKAGES=1 TAR_WRITER_OPTIONS=gzip:compression-level=9 npm run ship
```

The signing pass notarizes the universal app first, derives both CPU copies,
and signs and notarizes each copy and installer. It preserves sidecar
entitlements, signing requirements and runtime flags. Unchanged addon binaries
retain their signatures. All archive contents, updater signatures, installer
contents, native prebuilds and notarization tickets must verify before either
CPU entry can be published. A missing or mismatched package stops publication.

The updater maps `darwin-x86_64` to `o8_x86_64.app.tar.gz` and
`darwin-aarch64` to `o8_arm64.app.tar.gz`, each with its own signature.
The universal archive, signature and installer remain uploaded for fallback
and rollback. Stable and preview manifests retain their existing channels.
No website download selection or saved user setting changes in this mode.

Installed acceptance must cover first launch, update from universal to CPU
packages, update back to universal, relaunch/Dock behavior, workers, terminals,
settings, voice sidecars and native addon loading on each CPU. Static slice or
signature checks cannot substitute for these checks.
