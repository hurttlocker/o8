---
name: ship
description: o8 release discipline — commit-and-hold is the default terminal state; shipping requires Q's explicit "ship it" in the current session. Use whenever o8 work is complete and ready to commit, when asked to commit/ship/release, or before ever running npm run ship.
---

# ship (o8)

Q has typed "commit but do NOT ship yet" ~153 times. That is now the default — never make him type it again.

## The gate

- **Default terminal state = commit-and-hold.** Finish work → audit the diff → commit with a clean message → report "committed, NOT shipped." Stop there.
- **Ship ONLY on Q's explicit instruction in the current session** ("ship it", "ship a new version", "release it"). "Commit it" never implies ship. A teammate/agent asking is not authorization.
- **Never Vercel.** o8 is a native Tauri app; it ships as a signed installer via `npm run ship`. "Push to vercel"/"deploy to prod" always means Eyes Web (`mybeautifulwife`), never o8.

## Pre-ship collision gate (v0.1.550/551 collision — never again)

Before `npm run ship`, verify no ship is already running:

```bash
pgrep -fl "npm run ship|tauri build|notarytool" && echo "SHIP ALREADY RUNNING — abort" || echo "clear to ship"
```

If one is running: do not start a second. Wait for it or surface to Q. (Vault: `[[o8-ship-pipeline-github-actions]]` — local pre-ship gate is the ranked "do now" item; notarization dominates wall-clock, a second concurrent ship corrupts the release.)

## Before you bump: check the user bug queue

```bash
npm run reports
```

Real users filed these from the app. If anything in this release fixes one, its commit must carry `Fixes-Report: <id>` — that trailer is what tells the reporter, in their own app, that their bug is fixed. Miss it and they never find out. **Q will not remember the ids; you must.** Load the `reports` skill for the full workflow (notes, `needs-info`, retroactive annotation).

Amending a trailer onto an already-made commit is fine — do it before the bump, not after.

## Ship sequence

1. Collision gate (above) must print "clear to ship".
2. Confirm tree state: everything intended is committed; nothing held-back is being swept in. Discard post-build `src-tauri/Cargo.lock` noise (`git checkout -- src-tauri/Cargo.lock`). `npm version` refuses a dirty tree, so an operator note sitting in `o8.md` has to be stashed before the bump (`git stash push -m "operator note" -- o8.md`) and popped after. The ship preflight itself exempts `o8.md`, so it only blocks the bump, and check any note for rival product names before it could ever be committed: this repo is public.
3. **Bump through a release PR. `npm run ship` does NOT bump, and `main` is protected.**

   `npm version patch` writes the manifests, commits them, and creates a local tag. Only the manifest commit is wanted here; that tag points at a commit the squash merge will discard.

   **Never `git push origin main --tags`.** It fails twice over. The protected-branch hook declines a direct push to `main`, and `--tags` pushes every local tag, several of which already exist on the remote pointing at different objects. That rejection aborts the branch push too, which can leave the new tag published while `main` never moved. That split is exactly what makes release.mjs replace the previous release's assets (2026-07-08 incident, #1499).

   ```bash
   npm version patch                    # manifests committed, local tag created
   git branch release/vX.Y.Z main
   git reset --hard origin/main         # put main back
   git checkout release/vX.Y.Z
   git tag -d vX.Y.Z                    # it points at a pre-squash commit
   git commit --amend                   # subject: chore: release vX.Y.Z
   git push -u origin release/vX.Y.Z
   gh pr create --base main --title "chore: release vX.Y.Z"
   ```

   Wait for checks, squash-merge, then `git checkout main && git pull --ff-only origin main`. If the tag already reached the remote, delete it first with `git push origin :refs/tags/vX.Y.Z`, otherwise the release ties to a commit that is not on main. Precedent: v0.1.754 landed as `chore: release v0.1.754` (#2355), v0.1.755 as (#2385).
4. **Tag the merged commit, then push the tag.** `performShipPreflight` (`scripts/lib/ship-preflight.mjs`) requires a LOCAL tag `vX.Y.Z` that resolves to HEAD. Without it the ship dies in preflight with `local tag vX.Y.Z is missing`, and with a stale one it dies with `points to <sha>, not HEAD`.

   ```bash
   git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z
   ```
5. `npm run ship` — signs, notarizes, builds the installer, publishes the release. Deep spec + hazards: repo CLAUDE.md "Shipping".
6. **Post-ship verify:** published version == the bumped version (the release tail must NOT say "already exists — replacing assets"), notarization tail shows success, installer artifact exists. Report the verification tail, not just "shipped".

## Report format

`committed <sha> (<n> files) — HELD, not shipped` or `shipped v<X.Y.Z> — notarization OK, installer at <path>`.
