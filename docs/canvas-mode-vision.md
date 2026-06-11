# Canvas Mode + the 2028 surface thesis

**Status:** research synthesis · 2026-06-11 · direction doc for the UI/Canvas session. Operator intent: *"reuse the glass we already have to give users the Siri feel with o8 performance — the computer as an agent working with them through tasks — without the feel of a complete IDE."*
Sister docs: [`ui-surface-atlas.md`](./ui-surface-atlas.md) (what exists today), [`harness-vision.md`](./harness-vision.md) (the CLI/MCP harness future), epic #1204.

### The 2026 convergence — the IDE is already demoted

Between Q4 2025 and mid-2026 every serious player made an agent-fleet surface primary and the editor a fallback: the **Codex app** is a three-zone "command center" (project sidebar → thread panel → review pane) with worktree isolation — it validated o8's packet/lane model almost exactly; **Cursor 3** rebuilt its primary surface from scratch as a unified all-origin agents window and calls the IDE "a fallback" (their data: 2× more users run autonomous agents than tab-completion); **Devin Desktop** made a kanban of agents the default; **Warp Oz** runs Claude Code + Codex side-by-side as a control plane. Codex's user complaints — reasoning hidden by default, no model control — are *observability/governance* gaps, i.e. o8's stated moats. One important counter-signal: the Cursor 3 backlash ("I still want to code, not vibe through tickets") means the new surface must be **additive and dismissible**, never a forced replacement.

### Apple just validated the glass + the Siri feel

WWDC 2026 (two days before this doc): a dedicated **Siri app** — full-screen conversational surface, voice and text co-equal, persistent cross-device threads; agentic demos where the OS executes multi-step tasks you glance at rather than drive. **Liquid Glass** is now a three-principle design law ("controls float above content in glass layers — content always leads") and **macOS 27 shipped a system-wide glass↔opaque slider** — which is o8's two-axis `palette × surface` theme as an OS-level control. o8's glass chrome over solid workspace paper is not a styling choice anymore; it's the platform-native expectation for 2028. Lean in.

### Canvas — the strong version vs the gimmick

Evidence from Flora ($52M, creative canvas), tldraw computer, and **Maestri** (CLI coding agents as terminal nodes on a native infinite canvas, drag-to-delegate, on-device task summarizer): canvas wins for **parallel, glanceable, spatially-remembered live work** and loses when it forces linear work (one chat, one diff) to be spatial, or becomes a node-graph builder (that niche is owned; it's a *pipeline definition* tool, not live ops). Documented canvas costs: navigation overhead, no mobile story.

- **Strong version (build):** a freeform spatial **overview of live task-objects** — packets floating as glass cards you arrange, status readable from across the room, dive-in opens the focused panel/chat.
- **Gimmick version (avoid):** node-graph agent builder; canvas-as-the-only-surface; spatializing single-threaded work.

**The wedge in one line:** Maestri is o8's Canvas mode minus governance, voice, and memory. Canvas mode = Maestri's spatial fleet surface, in Liquid-Glass-native chrome, driven by Symon's voice verbs, with approvals as floating confirm-cards and Cortex underneath. No 2026 incumbent has assembled that.

### The seven bets (ranked, with confidence)

1. **Fleet-overview is home; the editor is a dismissible deep-work panel** — VERY HIGH (already true industry-wide; o8 is 80% there).
2. **Supervision moves human-in-the-loop → human-ON-the-loop**: auto-approve the safe, gate only merges/prod/spend/destructive — VERY HIGH. o8's 5-layer escalation chain is already shaped for this; the default needs to shift from gate-everything to gate-the-dangerous-few. *Highest-leverage product move on this list.*
3. **Voice is a co-equal control plane for orchestration verbs** (dispatch/steer/status/approve — short, high-level, exactly Symon's verbs) — HIGH.
4. **Glass floating over content is the default Mac-native look; glass↔solid is OS-standard** — HIGH. Already shipped in o8.
5. **A spatial canvas layer wins for the fleet overview specifically**, alongside panels for deep work — MEDIUM-HIGH (Maestri is the only coding precedent; the value mechanism — spatial memory of parallel live work — is proven elsewhere).
6. **Cross-surface state continuity (desktop↔mobile↔voice) is the lock-in** — HIGH (it's Codex's actual moat).
7. **Organizational memory is the durable differentiator as supervision automates away** — HIGH; this is Cortex's thesis.

### What o8 already has → what Canvas mode needs

Have: glass chrome + two-axis theme (ahead of curve) · Symon voice verbs + dock glass/motion language (the "working-vs-waiting" motion is the status-at-a-distance vocabulary to port) · PacketCard as the natural task-object · Orchestrator tab as the dive-in panel · approvals + escalation chain · Cortex memory · mobile surface.

Net-new for Canvas mode, in order:
1. **Freeform spatial layer for live packet-objects** with persisted positions (the `tiles/` manager is a tiling tree, not a canvas; the unused `canvas` tab kind is free real estate).
2. **Glanceable state on each object** — port the Symon dock's working/waiting motion + one orange accent rules to packet-objects readable at distance.
3. **HOTL approval default for canvas** — observing everything is the canvas's premise; a floating glass confirm-card appears only when a dangerous gate trips.
4. **Voice ↔ canvas binding** — "dispatch X" spawns an object; "what's shipping" highlights objects; approve/steer by voice.
5. **Mobile degradation** — same objects render as a list on mobile; never attempt canvas there.

### Build now vs wait

**Now:** the surface-truth cleanup (atlas), HOTL gating defaults, voice-verb hardening, the spatial packet-object layer prototype behind a flag. **Wait:** node-graph builders, canvas-as-only-surface, on-device model work (the Brain already covers summarization), any forced removal of existing panels — additive and dismissible, always.
