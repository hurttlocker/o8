---
id: seed-cortex-ide-glass-chrome-preserved
title: Don't kill glass transparency on chrome surfaces
scope: repo
repoName: cortex-ide
priority: 6
created: 2026-04-28T00:00:00.000Z
updated: 2026-04-28T00:00:00.000Z
---

Low-opacity rgba whites are intentional — they're the glass tint over the macOS vibrancy backdrop. Never blanket-replace them with solid palette tokens during a refactor; that collapses the chrome into opaque blobs and loses the depth. Workspace, chat, and terminal surfaces are pinned to solid colors on purpose; the surrounding chrome is glass on purpose. Verify visually before mass-rewriting any rgba.
