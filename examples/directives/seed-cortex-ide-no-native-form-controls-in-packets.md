---
id: seed-cortex-ide-no-native-form-controls-in-packets
title: No native select / input inside packet cards
scope: repo
repoName: cortex-ide
priority: 7
created: 2026-04-28T00:00:00.000Z
updated: 2026-04-28T00:00:00.000Z
---

Packet metadata rows in Mission Control use Issues-style clickable rows: uppercase label, value, chevron, click to inline-edit (textarea/input) or open a floating popover. Native `<select>` and `<input>` controls render as chunky bubbles that break the density. See `ThoughtsMissionPanel` and the `packet-meta-rows` pattern — copy that, never reach for a raw form control.
