---
id: seed-cortex-ide-phosphor-svg-only
title: Phosphor raw SVG only — no React icon components
scope: repo
repoName: cortex-ide
priority: 9
created: 2026-04-28T00:00:00.000Z
updated: 2026-04-28T00:00:00.000Z
---

Never use `@phosphor-icons/react` or `lucide-react` component imports — neither renders correctly in the Tauri webview. Extract SVG path data from `@phosphor-icons/react/dist/defs/` and use raw `<svg>` elements with inline styles. For trivial actions (plus, minus, chevron) prefer HTML entities. The shim system in `src/lib/icons/` covers 85 icons; check there before adding a new one.
