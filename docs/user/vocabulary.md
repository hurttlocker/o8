This glossary covers o8's core product terms across runtime, session, packet, lane, mission, review, and approval surfaces. It is for operators, orchestrator agents, and MCP integrators who need shared vocabulary without breaking UI labels, prompts, persisted state, or public API contracts.

# o8 Vocabulary

The canonical glossary for o8's primitives across audiences. **Read this before renaming anything that appears in more than one surface.**

o8 has three audiences. Each gets vocabulary tuned to its constraints:

| Audience | Surfaces | Constraint |
|---|---|---|
| **Operator** (you, the human) | desktop UI labels, mobile UI, status bar | Whatever maps to your mental model. May diverge from MCP/code. |
| **Orchestrator** (Claude, the planning LLM) | `src/lib/lane/orchestrator.md`, system prompts | Tracks MCP tool names so the LLM's tool-use reasoning lines up. |
| **MCP integrators** (Hermes Agent, OpenClaw, Claude Desktop) | `src/lib/mcp/operator-mcp-server.ts` tools, public API | **Frozen** for stability. Renaming an MCP tool is a public API break. |

The rule: **MCP tool names and DB column names are frozen. The orchestrator system prompt tracks MCP. UI labels track the operator's mental model and may diverge — divergences are listed below.**

## Primitives

Eight load-bearing concepts. Different lifetimes, different write authorities, different DB tables. Do not collapse.

| Concept | What it is | Code term | DB / type |
|---|---|---|---|
| **Runtime** | Adapter abstraction for a CLI agent (Codex / Claude Code / Gemini / opencode / Pi). | `runtime` | `OrchestratorRuntime` union |
| **Agent** | A live runtime process — one CLI invocation in one worktree. | `agent` | (no DB row of its own; surfaces via the lane it owns) |
| **Session** | A conversation thread inside a runtime. One runtime can carry many resumed sessions. | `session` | `ide_sessions` (registry) |
| **Packet** | The orchestrator's unit of planned work — a brief + result. May be retried (creating new lanes) or never dispatched. | `packet` | `OrchestratorPacket` |
| **Lane** | The durable execution row binding a session to a worktree to a packet. The "live work" record. | `lane` | `lanes` table |
| **Mission** | The current batch of packets the orchestrator has in flight. There is exactly one active mission at a time. | `mission` | `OrchestratorMissionState` |
| **Review** | The diff verdict surface — accept, reject, or request changes. | `review` | `session_outcomes` |
| **Approval** | A permission gate on a tool call or lane action. Not the same as review. | `approval` | `approvals` table |

### Why each stays separate

- `runtime` ≠ `agent` ≠ `session` — a runtime is an adapter class; an agent is a process; a session is a thread inside the process. A runtime can spawn many agents over its life; an agent can resume into many sessions.
- `packet` ≠ `lane` — packet is the *plan*, lane is the *execution*. One packet → 0..N lanes (retry creates a new lane). Same DB / different writers / different lifetimes.
- `mission` ≠ `packet` — a mission is the active batch wrapper. Half the MCP tools (`create_mission`, `dispatch_mission`, `get_mission_status`, `wait_for_mission_ready`) are batch operations; the other half (`reset_packet`, `retry_packet`, `submit_review`, `o8_packet_transcript`) target individual packets.
- `review` ≠ `approval` — review is per-packet diff verdict; approval is per-tool-call permission.

## Surface map

How each concept actually shows up across audiences. Cells marked **(divergent)** are deliberate — the operator label is intentionally different from the MCP / DB term.

| Concept | MCP tool | Orchestrator prompt | Desktop UI label | Mobile UI | DB / type |
|---|---|---|---|---|---|
| Runtime | (implicit) | `runtime` | (hidden in pickers) | runtime picker | `OrchestratorRuntime` |
| Agent | `o8_status`, `cortex_launch_agent` | `agent` | (no top-level label) | `agent` | (no row) |
| Session | (implicit in status) | `session` | tab `kind:'chat'` *(historic — see gotcha)* / `'llm-chat'` | inbox session | `ide_sessions` |
| Packet | `create_mission`, `reset_packet`, `retry_packet`, `o8_packet_transcript` | `packet` | **"Packets" tab** *(divergent — id is `'agents'` for state-key compat)* | inbox card | `OrchestratorPacket` |
| Lane | `o8_lane_events` | `lane` | (hidden in PacketCard meta) | n/a | `lanes` |
| Mission | `create_mission`, `dispatch_mission`, `get_mission_status`, `wait_for_mission_ready` | `mission` | (no operator-facing label) | n/a | `OrchestratorMissionState` |
| Review | `o8_review_state`, `submit_review`, `approve_and_merge`, `o8_merge_preview` | `review` | PR panel "Changes" / Review surface | approval card | `session_outcomes`, `approvals` |
| Approval | (none — UI/lane only) | `approval` | ApprovalStack | ApprovalStack | `approvals` |

### Documented divergences

- **"Packets" tab id is `'agents'`** — `LeftPanelProjectFocus.tsx` and `RepoTabs.tsx` carry `{ id: 'agents', label: 'Packets' }`. The id is unchanged for localStorage state-key compatibility; only the visible label was relabeled (May 2026). Future cleanup may align the id, but it requires a state-migration.
- **`kind:'chat'` tab kind ≠ casual chat** — `WorkspaceTerminal` tab kinds are `'terminal' | 'chat' | 'llm-chat' | 'canvas' | 'orchestrator'`. `'chat'` is a single-runtime CLI session (Codex / Gemini / opencode / Pi); `'llm-chat'` is the casual orchestrator chat. Documented at `src/components/desktop/workspace-terminal/types.ts`. Rename to `'cli-session'` is tracked debt — 75 sites + persisted-layout migration. Defer until forced.
- **Palette `dark` vs "midnight"** — `PaletteId` is `'light' | 'dark'` (`src/lib/theme/registry.ts`); the Appearance card labels match (`Light` / `Dark`). `midnight` is a LEGACY id remapped by `LEGACY_THEME_IDS` in `src/lib/theme/context.tsx`. Older docs/memories that say "midnight" mean today's `dark`. Verified 2026-06-11.
- **`OrchestrationMode = 'fleet' | 'single' | 'chat'`** — surface-level mode for the orchestrator chooser. Post-#650 (claude-code dropped as dispatch target) it's worth re-investigating whether `'fleet'` and `'single'` still drive different code paths or whether they could collapse. Tracked as future cleanup.

## Retired surfaces (do not reintroduce)

These were deleted but their names still appear in stale comments / dead exports occasionally. If you see them, prefer to remove the reference rather than restore the surface.

- **Mission Control** — historic right-side panel, deleted May 2026. Functionality distributed across the Packets tab (in `LeftPanelProjectFocus`) + O8Panel (Activity, Pulse, PRs).
- **`thoughts`, `mission-control`, `orchestrator-history` tile kinds** — TILE_LAYOUT_VERSION 4 migrates persisted layouts away from these to plain `terminal` leaves.
- **`OrchestratorChatTile`, `MissionControlTile`, `OrchestratorHistoryTile`, `orchestrator-tile-bus`, `ThoughtsMissionPanel`, `WorkspaceSidePanel`** — components, deleted.

## Renaming policy

| Surface | Cost to rename | When OK |
|---|---|---|
| MCP tool name | **High** — public API break for Hermes / OpenClaw / Claude Desktop installs | Avoid. If unavoidable, add the new name as an alias + deprecate the old name across at least one release before removing. |
| DB column | **High** — schema migration + every consumer | Avoid. Aliasing in code is cheaper. |
| `OrchestratorRuntime` literal | Medium — touches every dispatch switch | Only when adding/removing a runtime (see `docs/internals/runtime-adapter-contract.md`). |
| Tab `kind` literal | Medium — TILE_LAYOUT_VERSION bump + `migrateNode()` case + ~75 sites | When forced (e.g., new tab kind that conflicts). |
| Orchestrator system prompt term | Low — single file, but track that the LLM has been trained to associate the old term | Free for clarification; align to MCP names where possible. |
| UI label | **Low** — string change | Free. Update the divergence table above when you do. |

## When you need to add a new concept

1. Pick the term that fits each audience. They may differ.
2. Add a row to the surface-map table above.
3. If a new MCP tool: pick a name with a noun-verb shape (`o8_<noun>_<verb>` for read, `<verb>_<noun>` for write). Stay consistent with the existing prefixes.
4. If a new tab kind or DB column: bump the relevant version (TILE_LAYOUT_VERSION, db migration marker).
