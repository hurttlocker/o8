# Remote release app handoff

A remote macOS builder can produce the unsigned universal app. The release host
imports that app through the normal `npm run ship` workflow, then signs,
notarizes, packages, and publishes it with the existing release gates.

## Producer contract

Use a clean checkout at the exact release commit and version. Build with the
production webpack recipe, the `universal-apple-darwin` target, and the
`dev-mcp-plugin` feature. The app shell must be unsigned or ad-hoc signed. The
handoff is an intermediate build artifact, not a signed release.

The builder and release host must have identical public build configuration.
Use a clean release checkout without dotenv files, or identical dotenv inputs
on both hosts. The manifest compares public build environment values, resolved
`o8.release.json` values, release channel, and dotenv file digests. It contains
hashes rather than configuration values. Do not transfer signing credentials,
notary credentials, updater keys, or arbitrary command strings to the builder.

Build controls `O8_BUILD_HEAP_MIB` and `O8_NATIVE_BUNDLE_CACHE_DIR` affect memory
or cache placement. They are excluded from public product configuration identity.
Use the normal production build scripts so cache hits retain their validation.
Use `O8_BUILD_SUPERVISED=1` for the guarded builder so packaged smoke children
remain within the supervising process group.

After building, place the app at `o8.app` beside the output manifest and call:

```js
import { writeRemoteReleaseAppManifest } from './scripts/lib/remote-release-app.mjs';

const { manifestPath, manifest } = writeRemoteReleaseAppManifest({
  root: releaseCheckout,
  appPath: `${handoffDirectory}/o8.app`,
  outputPath: `${handoffDirectory}/handoff.json`,
  env: process.env,
});
```

The writer refuses an existing output manifest. Transfer the complete directory
with file modes and relative symlinks preserved. A manifest digest verifies
integrity against that manifest; the handoff must still come from the approved
builder and transport. It is not a substitute for builder authentication.

The `o8/remote-release-app/v1` manifest records the exact Git commit and tree,
version, tracked build recipe digest, production configuration digest, fixed
build options, full app inventory, inventory digest, and required Mach-O
architecture identities. Every directory, file byte digest, file mode, and
symlink target participates in verification. Absolute, escaping, dangling, and
special filesystem entries are refused. Both app version fields, the executable,
and the committed macOS bundle identifier must match. The system plist parser
validates the actual metadata rather than searching plist text.

## Release host

After the normal version, tag, clean-checkout, credential, and release approval
steps, set the manifest path for the existing ship command:

```sh
O8_RELEASE_APP_HANDOFF=/path/to/handoff/handoff.json npm run ship
```

The release lock and preflight still run first. Only the build stage changes:
`scripts/import-release-app.mjs` imports the verified app instead of compiling
locally. The CLI accepts no arguments or command overrides. It has no production
test bypass. Without `O8_RELEASE_APP_HANDOFF`, the local build is unchanged.

The importer checks source, configuration, app version, universal binaries,
signature state, and the complete inventory before touching the current app.
It copies into a private sibling staging directory and repeats verification,
then renames the previous app into that directory and moves the staged app into
the release resolver's universal destination. A failed validation preserves the
previous app. A failed replacement or receipt publication restores it. The
previous app remains at the recorded recovery path until the existing successful
postship cleanup reclaims native release outputs.

The `o8/remote-release-app-import/v1` receipt records the manifest byte digest,
verified app digest, source identity, installed relative path, and previous-app
recovery path. Signing later changes the app bytes; this receipt describes the
verified pre-signing import. The existing signing, notarization, updater archive,
installer, size, and publication checks establish the final release identity.
Receipts are published under `out/remote-release-imports/`, which the existing
postship cleanup preserves.

## Verification

`tests/remote-release-app.test.ts` exercises the real import CLI with a synthetic
universal app, persisted receipt, and previous-output recovery. It checks altered
bytes, modes, links, inventory, source, version, public configuration, dotenv
inputs, unsafe paths, and unchanged default shipping stages. On non-macOS test
hosts, a test-only preload supplies the platform and unsigned signature response;
production code has no flag that enables that adaptation.
