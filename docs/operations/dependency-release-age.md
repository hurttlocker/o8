# Dependency release age

The repository `.npmrc` sets `min-release-age=7`: npm dependency resolution
selects versions published at least seven days ago. A range can select an older
matching release; an exact version that is too new fails resolution. This is a
delay for new releases, not a vulnerability scanner or a guarantee of safety.

Use npm 11.10.0 or newer. Older npm versions can ignore the setting. The current
`package.json` pins worker installs to npm 11.8.0, so those installs remain
unprotected by this setting. Updating the worker toolchain remains open in
[#4514](https://github.com/o8-run/o8/issues/4514). CI installs `npm@11`;
the real-path regression refuses an unsupported npm version rather
than reporting a pass. The test uses a loopback registry with a thirty-day-old
release and a one-hour-old release. It verifies range selection, exact-version
refusal, the explicit override, and selection with that supported CLI inside a
packet checkout created by `WorktreeManager`, with isolated npm user and global
configuration. It does not test the pinned npm 11.8.0 worker install command.

The tracked project configuration follows new o8 packet worktrees. Worker
installs isolate user/global npm configuration but still read the checkout's
`.npmrc`; dependency recipes already include that file in their input digests.
Reading the file does not make an unsupported npm enforce the setting.
This policy applies to this repository. Other repositories retain their own
package-manager policy. Existing lockfiles replay their pinned versions:
`npm ci` is not a separate age audit of an already reviewed lockfile.

## Urgent security fixes

When waiting would leave a known vulnerability unpatched, review the release
and its source, then apply an override to that one command:

```sh
npm install <package>@<reviewed-version> --min-release-age=0
```

Review the resulting manifest and lockfile diff and run the affected checks.
Record the advisory, version and reason for the exception in the pull request.
Do not edit the repository setting, save a global override, or export an
override into subsequent worker launches. The next resolution uses seven days
again. The override fixture verifies that the repository setting stays intact.

## Run the proof

```sh
npm run test:integration -- tests/npm-release-age-real-path.test.ts
```

For an older local npm installation, `O8_TEST_NPM_CLI` can point to a separately
unpacked supported `npm-cli.js` for this test invocation. This does not update
the installed package manager or claim that the older version enforces the
policy. The test installs no dependencies into the development checkout,
executes no package lifecycle scripts and uses no external registry.

See the [npm configuration reference](https://docs.npmjs.com/cli/v11/using-npm/config#min-release-age)
for units and resolution behavior and the
[npm changelog](https://github.com/npm/cli/blob/latest/CHANGELOG.md#11100-2026-02-11)
for the supported-version boundary.
