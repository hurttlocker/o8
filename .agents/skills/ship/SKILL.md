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

## Ship sequence

1. Collision gate (above) must print "clear to ship".
2. Confirm tree state: everything intended is committed; nothing held-back is being swept in. Discard post-build `src-tauri/Cargo.lock` noise (`git checkout -- src-tauri/Cargo.lock`) — a dirty tree fails the bump.
3. **Bump first — `npm run ship` does NOT bump.** `npm version patch` (commits manifests + tags via sync-version.mjs), then `git push origin main --tags`. Skipping this makes release.mjs silently REPLACE the previous already-published release's assets under the same version (2026-07-08 incident, #1499) — updaters then never see the new build.
4. `npm run ship` — signs, notarizes, builds the installer, publishes the release. Deep spec + hazards: repo AGENTS.md "Shipping".
5. **Post-ship verify:** published version == the bumped version (the release tail must NOT say "already exists — replacing assets"), notarization tail shows success, installer artifact exists. Report the verification tail, not just "shipped".

## Report format

`committed <sha> (<n> files) — HELD, not shipped` or `shipped v<X.Y.Z> — notarization OK, installer at <path>`.
