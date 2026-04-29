---
id: seed-cortex-ide-800-line-ceiling
title: 800-line file ceiling — decompose before adding
scope: repo
repoName: cortex-ide
priority: 8
created: 2026-04-28T00:00:00.000Z
updated: 2026-04-28T00:00:00.000Z
---

Files must stay under 800 lines. If your change would push past 800, decompose first: extract helpers, hooks, sub-components, or modules before adding new logic. Layout orchestrators (`src/app/dashboard/page.tsx`) and multiplexers (`src/ws-server.ts`) are explicitly waived. The recall-card sub-components and packet-review-card panes are good examples of the decomposition pattern.
