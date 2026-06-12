# Canvas mode — v1 implementation plan (one page)

**Status:** approved (Q, 2026-06-11) · builds on [`canvas-mode-vision.md`](./canvas-mode-vision.md) (strong version only). Everything here is additive and dismissible; nothing replaces an existing surface. **Fine-tuned 2026-06-11 against CNVS** (cnvs.dev, @_MaxBlade — the surface that seeded the idea); see "CNVS reference notes" at the bottom for what we borrow vs deliberately invert.

---

## Direction change — Canvas mode v2 (Q, 2026-06-11, supersedes the tab framing)

After seeing v1, Q pivoted the destination: Canvas is not a tab — it's a **mode**. "When you click canvas, everything is glass." The locked v2 direction:

- **Settings is the ONLY gate.** The `experimentalCanvas` toggle (Settings → Operator Defaults) is the single entry point — flag off means no canvas access *anywhere*. The v1 spawn rows in the New-session menus were removed; the `fleet-canvas` tab plumbing stays as internal substrate.
- **Full-glass revamp, Siri material.** In canvas mode the entire app re-skins to dark tinted clear glass (the Apple Siri reference) — not light/dark themes, "straight glass." The material is **operator-tunable**: frost (backdrop blur), tint (dark glass density), ink (text brightness) sliders live under the settings toggle (`src/lib/canvas-mode/glass-settings.ts`, CSS vars `--cnv-*`, localStorage `o8:canvas-glass`).
- **Test page first.** `/preview/canvas-glass` renders the full anatomy in the real material so the glass gets nailed *before* the shell revamp. Flag-gated like every canvas surface.
- **Anatomy (from the CNVS image-8 reference, minus their background — we go glass + sliders):**
  - **Top dock** — the existing important header controls (Agents / Alerts / Settings / Exit). **NOT Symon** — Symon lives in the macOS dock above everything; he is never a canvas element.
  - **Left spawn dock** — spawn objects onto the canvas: orchestrator, browser, o8.md panel for a repo, terminal.
  - **Left/right edges** — auto-minimized hover-reveal rails (sessions / activity feedback).
  - **Bottom input** — the orchestrator composer for the scoped repo.
  - **Glass cards** — packet-objects, draggable, status via the Symon-dock motion vocabulary.
- **Who touches it.** "The canvas is not for the human to touch; it's more so for Symon to manipulate." Hierarchy: the operator talks to Symon (system level) → Symon tells the orchestrator (bottom composer) → things pop up on the canvas. Voice-first fleet control; the human watches and approves.
- **Shipped in the v2 slice (0.1.354):** settings-only gating (menu rows removed), glass-settings lib + `CanvasGlassTuner` sliders in Operator Defaults, `/preview/canvas-glass` test page (material + anatomy + interactions verified). The full shell re-skin builds on the tuned material after Q signs off the look on the test page.

The v1 plan below shipped as 0.1.352 and remains accurate as history + substrate detail.

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

## Phased after v1 (explicitly out of scope now; re-ranked 2026-06-11 after the CNVS study)

1. **Canvas composer (persistent command bar)** — pulled up from #3 after CNVS: their bottom-anchored always-present bar (not a modal ⌘K) is the product's spine — every spawn, task, and view change flows through it. Ours is nearly free: mount the existing orchestrator composer slim at bottom-center of the canvas, routed to the same thread plumbing. Dispatching from it makes cards appear on the canvas live.
2. **HOTL confirm-card** — approval gates render as a floating glass confirm card over the canvas (the dock's confirm-card pattern, ApprovalBanner data). This is the human-ON-the-loop bet and deserves its own slice. CNVS has NO governance layer ("ship to production like a psychopath") — this card is exactly our differentiation on this surface.
3. **Symon voice binding** — Symon verbs spawn/highlight objects ("what's shipping" pulses the working cards; "spawn three Codex agents on o8" drops three cards). CNVS validates voice-commands-the-fleet with gpt-realtime-2; we already own the Symon presence layer, so this is wiring, not research.
4. **Forge-style column snap** — CNVS's "forge" is a bidirectional multi-agent kanban (cards in status columns; moving a card re-tasks the agent). Our packets already carry the lifecycle; a layout toggle that snaps free-form cards into status columns (and lets a drag BETWEEN columns trigger a real action: queued→running = dispatch, running→archived = interrupt) is the governed version of bidirectional.
5. **Text notes on canvas** — CNVS lets the operator type planning notes (a "GOALS" box) next to agents. Cheap, humane, later.
6. **Mobile:** never a canvas — the same packet list mobile already renders is the degradation. Nothing to build.

## Verifiable success criteria (v1 slice)

1. Flag off → app byte-identical in behavior; flag on → Canvas row appears in New-session expansion.
2. Open canvas with N live packets → N cards render with correct status motion; dispatch a packet elsewhere → card appears live without reload.
3. Drag a card, reload the app → position survives.
4. Click a card → the packet's existing session surface focuses.
5. `npx tsc --noEmit` clean; no new tile kind appears for flag-off users; midnight + light + reduce-transparency all verified by screenshot.

**Estimate:** ~2 files new (`FleetCanvasTab.tsx`, `fleet-canvas-store.ts`) + small touches (types union, New-session menu, flag plumbing). Comfortably one session in dev-bridge.

---

## CNVS reference notes (2026-06-11)

Source material: @_MaxBlade tweets 2063240530381660647 + 2063417589104062661 and the full cnvs.dev demo, watched via Gemini vision (analyses saved at `~/UGC/data/analyses/cnvs-*.json`). CNVS is where the canvas idea came from — native Swift macOS, $99 one-time, BYO keys, orchestrates Claude Code / Cursor / Codex as named agents (Marshall / Chase / Ada) on an infinite canvas, voice via gpt-realtime-2, "forge" kanban, claims 150+ agents from one prompt.

**What CNVS validates in this plan:**
- Spatial canvas of live agent objects with streaming presence — the core bet is real and it reads great on video.
- Dive-in / pull-back-out between fleet overview and a single agent's surface (theirs is a hard cut, not a zoom — our tab-focus dive-in matches).
- One big canvas, no chrome — the window is the canvas.

**What we deliberately invert (the governed canvas):**
- **Status legibility at fleet scale.** CNVS signals "working" almost entirely by streaming text into panes; at 10+ agents you can't tell stuck from succeeding without reading logs. Our cards lead with the Symon-dock motion vocabulary + status dot + ONE orange accent — status at a distance is the whole point of the surface.
- **Definite endings, not vanishing agents.** In the CNVS demo, finished agent panes just disappear (abrupt cut, no archive, no history). Per #1231, every o8 run ends in exactly one of fix / ask / PR / issue — on the canvas that's cards settling into the archived corner stack carrying their ending verb, never deletion.
- **Governance on the diff.** CNVS ships VPS→production with zero review surface. Our canvas dives into the existing review/approval surfaces; the phase-2 HOTL confirm-card floats the approval ON the canvas instead of hiding it.
- **Clear agent↔surface linkage.** CNVS's focus view doesn't say which canvas agent owns it; our dive-in lands on the packet's own session tab with its packet badge — linkage is structural.

**What we skip on purpose:** infinite pan/zoom (their demo hides whether navigation is even user-controlled; spatial memory needs stable geometry), 150-agents-as-a-flex (our fleet is sized by governance capacity, not spectacle), pixel-art backdrop theming.
