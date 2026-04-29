---
id: seed-cortex-ide-inline-styles-only
title: Inline styles only — no CSS classes anywhere
scope: repo
repoName: cortex-ide
priority: 9
created: 2026-04-28T00:00:00.000Z
updated: 2026-04-28T00:00:00.000Z
---

All styling lives in `style={{ }}` props on JSX. Never use CSS class names, stylesheets, or CSS modules. iOS Safari and the Tauri webview have shipped reliability issues with class-based styling — this is a permanent rule, not a stylistic preference. Use `as React.CSSProperties` when assigning vendor-prefixed or non-standard CSS properties.
