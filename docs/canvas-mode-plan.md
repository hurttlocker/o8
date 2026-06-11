# Canvas mode — v1 implementation plan (one page)

**Status:** awaiting operator approval · 2026-06-11 · builds on [`canvas-mode-vision.md`](./canvas-mode-vision.md) (strong version only). Everything here is additive and dismissible; nothing replaces an existing surface.

## What v1 is

A **fleet-overview tab**: live packet/task-objects as calm glass cards on a solid paper canvas, arranged freely by the operator, status readable at a distance, click to dive into the surfaces that already exist. NOT a node-graph builder; no edges, no pipelines.

## Where it lives

- **New tab kind `fleet-canvas`** in `workspace-terminal/types.ts`, rendered inside WorkspaceTerminal like `orchestrator`. The existing `canvas` kind (agent-created file/issue viewer, `Canvas.tsx`) stays untouched — repurposing it would collide with agent-created tabs. Adding a kind is forward-compatible; no `TILE_LAYOUT_VERSION` bump (that's for removals/renames).
- **Flag `experimentalCanvas`** in operator defaults, same pattern as `experimentalChat`/`experimentalGemini`. Flag ON adds one row to the New-session kind expansion: **Canvas — "Your fleet, spatially"**. Flag OFF = zero surface area.
- **Data: zero new backend.** The tab consumes `useOrchestratorData()` (packets, missionState, agents) exactly like OrchestratorTab/AgentsTab. Live updates ride the existing provider.

## The packet-object (glass card)

- ~200×84px card: packet title (13.5/300), repo + runtime meta line (9.5/260), one status dot. `var(--t-bg-card)` + soft blur **over solid `--t-canvas-bg` paper** — the center stays solid per DESIGN.md; the glass layers over paper, never over vibrancy.
- **Status at a distance = the Symon dock motion vocabulary**, not color soup: *working* = slow breathing (opacity/scale ≤1.02, the dock's working rhythm); *waiting on human* = still + the single orange accent; *merged/archived* = settles to a quiet corner stack; *failed* = still + red dot. One orange max per canvas, framer springs 400/30, no bounce.
- Drag to arrange; positions persist per workspace to localStorage (`o8:fleet-canvas:pos:<workspaceId>` → `{packetId: {x,y}}`), new packets auto-place in a left-to-right flow. No zoom/pan in v1 (the window IS the canvas; spatial memory needs stable geometry).

## Dive-in (reuse, don't rebuild)

Click a card → focus/open the packet's existing surface via the same plumbing AgentsTab uses (`onSelectSession` / `onOpenHistoryChat`); double-click the canvas background → nothing in v1 (no inline spawn yet). The card's hover reveals two quiet actions: View (dive-in) and Review (existing review surface) — hover-reveal per hurttlocker, no default-visible buttons.

## Phased after v1 (explicitly out of scope now)

1. **HOTL confirm-card** — approval gates render as a floating glass confirm card over the canvas (the dock's confirm-card pattern, ApprovalBanner data). This is the human-ON-the-loop bet and deserves its own slice.
2. **Voice binding** — Symon verbs spawn/highlight objects ("what's shipping" pulses the working cards).
3. **Dispatch-from-canvas** — composer summoned on the canvas.
4. **Mobile:** never a canvas — the same packet list mobile already renders is the degradation. Nothing to build.

## Verifiable success criteria (v1 slice)

1. Flag off → app byte-identical in behavior; flag on → Canvas row appears in New-session expansion.
2. Open canvas with N live packets → N cards render with correct status motion; dispatch a packet elsewhere → card appears live without reload.
3. Drag a card, reload the app → position survives.
4. Click a card → the packet's existing session surface focuses.
5. `npx tsc --noEmit` clean; no new tile kind appears for flag-off users; midnight + light + reduce-transparency all verified by screenshot.

**Estimate:** ~2 files new (`FleetCanvasTab.tsx`, `fleet-canvas-store.ts`) + small touches (types union, New-session menu, flag plumbing). Comfortably one session in dev-bridge.
