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
