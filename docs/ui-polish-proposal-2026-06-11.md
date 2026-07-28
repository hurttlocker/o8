# UI polish proposal — surface-truth walk findings (2026-06-11)

**Status: EXECUTED 2026-06-11** — groups (a)/(b)/(c) landed same-day in commits `afae36e1` / `3b160967` / `ab5d79f7`. Re-verified against code 2026-07-27: 16/18 confirmed fixed (some via later refactors); residual: item 10's trigger still wears the ellipsis glyph (fix in flight), item 17 needs a 4× screenshot-and-measure pass on the live app to confirm the optical column. Evidence was captured on installed o8.app 0.1.348, light + midnight, via window-ID screencapture + computed-style measurement. Grouping per the session contract: (a) safe fixes, (b) consistency unifications, (c) locked-geometry.

Already shipped this session (infrastructure, not pixels): `o8_view_screenshot` captured the Symon dock instead of the main window (title-search bug, fixed by own-pid CG match — plugin 66931f6 + o8 0.1.349); `[mcp-*]` eval beacons flooded the console-error ring (3 per eval, cap 100 — now log-only).

## (a) Safe fixes — bugs by the spec's own definition

1. **⌘K opens two palettes stacked.** `dashboard/page.tsx` and `OrchestratorTab.tsx` both bind window-level ⌘K; with an orchestrator tab active both CommandPalette and QuickActionPalette render overlapped, text colliding. Fix: one ⌘K owner (dashboard), drop the OrchestratorTab binding — the verb panel keeps its `/` path in the composer.
2. **`NaNd ago`** on the queued packet row in the Activity feed (date parse → NaN leaks to UI).
3. **Selected project row renders fontWeight 440** (`o8` row; siblings 300). hurttlocker anti-pattern #1: active state never bumps weight — bg tint already carries selection.
4. **Focus ring on left-panel rows clips into two full-width blue bars** (outline cut by panel overflow). Use inset box-shadow focus or rounded inline ring.
5. **`.cortex-worktrees/.meta.json` shows up as user changes** in the Workspace diff when untracked files are included — o8's own machinery must be excluded from the user-facing working-tree diff.

## (b) Consistency unifications

6. **Project rows sit at text x=36; the panel text column is x=42** (nav rows, chat rows agree at 42; section labels 34). Projects joined the panel after the column lock and missed the system. Align + give child repos a deliberate indent step.
7. **Composer accent density at rest**: orange usage bars + orange fleet glyph + red slashed-shield in one idle row; the shield-off glyph reads as an ERROR icon while meaning "Full access". Propose ink-muted at rest, color on state-change only; one orange max (usage bars when near limit).
8. **Merged read-only session still offers a live composer** ("Steer this Codex agent…", mic + send enabled) directly under the "Merged · read-only" banner. Swap to a resume/duplicate affordance on archived lanes.
9. **Tab pills truncate to first word at min width** — three siblings all read "Add". Middle-ellipsis or two-word floor.
10. **Diff-toolbar "More" (…) silently toggles untracked scope** — not a menu (good) but wears the banned ellipsis costume and gives no feedback. Replace with a labeled toggle chip ("Untracked").
11. **Activity feed structure**: "PROPOSED DIRECTIVES [14]" header visually owns the unlabeled commit feed below it; and one commit renders as 3 ungrouped sibling rows (commit / CI / changelog-sync). Add the missing section label + group satellites under their SHA.
12. **"dark" vs "midnight"**: Appearance palette card says "dark"; code/docs say midnight. Pick the user-facing name and record it in `docs/vocabulary.md`.
13. **Connectors page contradiction**: "#3 — REPOSITORIES: No tracked repositories yet" directly above "#4 — GITHUB APP: installed on @hurttlocker · 7 repos".
14. **Five duplicate `aria-label="Ask o8"` buttons mounted simultaneously** (plus "Ask o8 to review") — a11y duplication; also the audit hook for the unified ask-o8 affordance.
15. **Inbox carries Jun 2–4 stale failures** referencing pre-rename `cortex-ide/.cortex-worktrees` paths — needs the lane-staleness sweep / auto-expiry policy (known next-up in memory).
16. **Project identity dots use status-LED colors** (green dot on a project reads "running"). Identity ≠ status: mute the identity ramp or visibly differentiate.

## (c) Locked geometry — sign-off + optical re-measurement required

17. **Right-rail trailing icons off the optical column.** Panel-relative: ring holds the lock exactly (283 = 233 + 50 panel growth), but New-session trailing icon lands at 284 and the filter icon at 286 — the lock puts both on one column (285). The glyphs themselves changed since the lock (chevrons → menu/align-style glyphs), so each needs the screenshot-and-measure treatment before snapping; bounding-box math is explicitly not trusted here.
18. **hurttlocker absolute values drifted uniformly +5** (row/nav text 37→42, section labels 29→34) after the floating-card refactor — the *relationships* all held (meta is still exactly 9.5px/260). Proposal: update the spec's absolute numbers to as-built and re-lock, rather than moving the UI back.

## Walk debt (not auditable in prod this pass)

Project-focus "control room" drawer + PacketCards (opens via hover chevron — drive in dev-bridge), ReviewPanel + O8ScratchChat (needs a review context), FTUX (needs fresh state), ⌘/ overlay, Search/Automations surfaces, settings tabs below Plan & Billing.
