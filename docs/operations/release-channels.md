# Stable and preview releases

`main` is the integration branch. Pull requests must be up to date, resolve review conversations, and pass the seven required CI checks from the GitHub Actions app: Type Check, Lint, Hermetic Unit Tests, Security Audit, Governance Smoke, and both Rust Compile Gates. The rules apply to administrators. A second human approval is not required; merge approval remains an operator decision. Force pushes and branch deletion remain blocked.

## Development and nightly verification

Develop in a short-lived feature or fix branch, preferably in its own worktree. Open a pull request against `main`, retain the required checks, and merge only after approval. There is no permanent `dev` or `nightly` branch to keep synchronized. A development branch does not isolate application data. Source dev servers must use a disposable `CORTEX_IDE_DATA_DIR` and `O8_DATA_DIR` when testing state-changing behavior beside the installed app, with separate API and WebSocket ports.

The `Nightly Verification` workflow checks the default branch once a day at 06:23 UTC. It skips a commit that already passed this workflow; manual dispatch reruns the checks. A single job has a 20-minute ceiling, read-only repository permissions, and runs protocol, TypeScript, classification, and hermetic unit checks. The existing weekly resource-owning integration and security lane remains separate.

This is nightly source verification, not a downloadable nightly app or installed Mac acceptance. It creates no installer, tag, release, updater manifest, or announcement. The schedule becomes active only when its reviewed workflow reaches the default branch. Installable nightlies require the preview identity and data-isolation work described below, followed by an explicit publication-policy decision.

## Stable

The installed app uses the public mirror's `releases/latest/download/latest.json`. Keep that endpoint unchanged for normal users. `npm run ship` remains the explicitly approved stable publication path and requires a plain `X.Y.Z` version. Version changes go through a PR before tagging the merged commit. Release-note archives also go through a PR; publication never pushes archive commits to main.

## Preview publishing

Preview publishing requires a separate operator decision. It does not run on a schedule or on every push, and it does not create another permanent development branch.

1. Prepare a unique version such as `0.1.741-preview.1`, keeping all manifests synchronized. Review and merge the version PR before tagging the exact commit.
2. Inspect the publication policy with `O8_RELEASE_CHANNEL=preview node scripts/release.mjs --dry-run`. This does not build or publish.
3. After approval, use `O8_RELEASE_CHANNEL=preview npm run ship`. Signing, notarization, and the normal preflight still apply.
4. Verify that both repository releases are prereleases, neither is latest stable, and the tag contains `preview.json` plus signed installers. Preview publication does not upload `latest.json` or `fixed.json`, publish the stable changelog, archive release notes, reconcile report receipts, or post stable announcements.
5. Verify that the public latest stable release and its updater manifest remain unchanged. Preserve the candidate's test and install receipts.

Preview versions cannot use the clobber override. A repeated or failed candidate needs a fresh version; never replace an existing candidate's bytes. The manual Actions fallback only accepts preview-version tags and stages a draft prerelease. It does not publish a stable release or launch on a nightly timer.

## Boundaries still to implement

This is a publishing boundary, not an installed preview channel. Preview artifacts are reached explicitly by tag. The app does not yet offer a preview selector or a rolling preview feed, and stable and preview installs still share the application identity and user data. Do not install them side by side or use a preview to migrate the daily database as an acceptance shortcut.

Stable promotion requires a separate operator approval and verified installed acceptance. This path does not rename preview versions, retag artifacts, or promote automatically. A stable-number build needs its own exact signed-artifact receipt. App-side channel selection and data isolation must be reviewed separately before promising seamless preview enrollment.
