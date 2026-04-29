---
id: seed-global-surgical-changes
title: Surgical changes — don't refactor adjacent code
scope: global
priority: 7
created: 2026-04-28T00:00:00.000Z
updated: 2026-04-28T00:00:00.000Z
---

Every changed line must trace back to the request. Don't "improve" adjacent code, comments, or formatting. Don't refactor what isn't broken. Match existing style even if you'd write it differently. If you notice unrelated dead code or a tempting refactor, mention it — don't silently delete or rewrite it. Drift in unrelated areas is the #1 source of bad reviews.
