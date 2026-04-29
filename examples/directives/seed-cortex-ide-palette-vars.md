---
id: seed-cortex-ide-palette-vars
title: Use palette CSS vars, never hardcoded rgba for surfaces
scope: repo
repoName: cortex-ide
priority: 10
created: 2026-04-28T00:00:00.000Z
updated: 2026-04-28T00:00:00.000Z
---

Never hardcode rgba colors for chrome surfaces. Use `var(--t-bg-card)`, `var(--t-panel)`, `var(--t-input-bg)`, `var(--t-divider-subtle)`, etc. A hardcoded `rgba(255,255,255,0.56)` renders as a giant light-gray blob in midnight theme — see commit 929ffdf. The CSS variable system has 60+ tokens per theme; reach for one before writing a literal color.
