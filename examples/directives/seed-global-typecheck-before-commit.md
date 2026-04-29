---
id: seed-global-typecheck-before-commit
title: Always typecheck before commit
scope: global
priority: 8
created: 2026-04-28T00:00:00.000Z
updated: 2026-04-28T00:00:00.000Z
---

Run `npx tsc --noEmit` before every commit. CI will catch regressions but local checks save the round-trip and reviewer time. For Next.js repos prefer `npm run typecheck` (clears the typegen cache before checking). No exceptions on shared codebases — a broken typecheck blocks the whole team.
