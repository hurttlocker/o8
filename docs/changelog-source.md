# Public changelog source and cost

The ship-to-page path makes these external calls from the operator machine:

- Git pushes publish the source branch and release tag before shipping.
- Git checks that the release tag exists on the source remote.
- `gh release` reads, creates, or updates the source release and uploads its assets.
- `gh release` reads, creates, or updates the public mirror release and uploads the updater assets.
- `gh release view` reads the source release publication time for `latest-ship.json`.
- `gh repo clone` reads the public mirror branch into a temporary worktree.
- `gh api` conditionally reads pull-request head branches to infer `[via-o8]` markers.
- Git pushes one mirror commit containing `CHANGELOG.md`, `STATS.md`, and `latest-ship.json`.
- When `release-notes/next.md` exists, Git pushes the follow-up source commit that archives it under the shipped version.

All of these GitHub and Git calls run locally and none has a per-call metered cost. GitHub rate limits still apply.

The changelog page reads `CHANGELOG.md` and `latest-ship.json` from `raw.githubusercontent.com`. The site revalidates each source every 300 seconds. These reads are not metered.

The page can render either source by itself. It shows the fallback text only when the changelog fetch yields no dated entries and the latest-ship fetch yields no valid release.
