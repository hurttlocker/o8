# o8 v1 Production Roadmap

Generated March 31, 2026 from deep audits of:
- Claude Code leaked source (1,900 files, 512K lines)
- OpenAI Codex Plugin for Claude Code (codex-plugin-cc)

## The One Thing That Matters

Issues 1.1–1.4 form a single end-to-end loop: **type a task → agent executes in worktree → supervisor detects completion → approval gates merge → operator approves → code lands on main.** If that loop works, o8 is a product. Everything else makes it wider, deeper, and stickier.

---

## Horizon 1: NOW (This Week) — Usable Today

### Epic 1: Close the Orchestrator Loop

| # | Issue | Size | Days |
|---|-------|------|------|
| 1.1 | Wire packet dispatch to runtime adapters | L | 1-2 |
| 1.2 | Supervisor completion triggers packet state transition | M | 2-3 |
| 1.3 | Approval-gated merge from review state | M | 3-4 |
| 1.4 | One-shot "send task" from ThoughtsCard or chat | S | 4-5 |

### Epic 2: Clean Up OpenClaw Ghost References

| # | Issue | Size | Days |
|---|-------|------|------|
| 2.1 | Remove dead OpenClaw lib directory + residual imports | S | 1 |
| 2.2 | Rewire mobile controller sync after OpenClaw removal | M | 5-6 |

---

## Horizon 2: NEXT (This Month) — Competitive

### Epic 3: Hook Pipeline (The Governance Moat)

| # | Issue | Size | Week |
|---|-------|------|------|
| 3.1 | Claude Code hook adapter — PreToolUse/PostToolUse interception via MCP | L | 2 |
| 3.2 | Codex review gate — stop hook equivalent with approval | L | 2-3 |
| 3.3 | Policy rules configurable per workspace (~/.cortex-ide/policies.json) | M | 3 |
| 3.4 | Approval audit log viewer in Canvas | S | 3 |

### Epic 4: Context Compaction Awareness

| # | Issue | Size | Week |
|---|-------|------|------|
| 4.1 | Detect compaction events in Claude Code JSONL transcripts | M | 2 |
| 4.2 | Context usage percentage on session cards (progress ring) | M | 3 |
| 4.3 | Pre-compaction snapshot to Cortex memory | L | 4 |

### Epic 5: Cost Telemetry Integration

| # | Issue | Size | Week |
|---|-------|------|------|
| 5.1 | Parse Claude Code cost data from session metadata | M | 3 |
| 5.2 | Aggregate cost per packet/mission | S | 4 |

### Epic 6: Multi-Agent Coordination

| # | Issue | Size | Week |
|---|-------|------|------|
| 6.1 | Parallel Codex session spawning from single mission (DAG scheduler) | L | 3-4 |
| 6.2 | Cross-session context passing via Cortex memory | M | 4 |

---

## Horizon 3: LATER (This Quarter) — Definitive Governance Layer

### Epic 7: Skills as Progressive Disclosure

| # | Issue | Size | Month |
|---|-------|------|-------|
| 7.1 | Skills directory with frontmatter-only startup loading | L | 2 |
| 7.2 | Skill sync across Claude Code and Codex sessions | M | 2 |

### Epic 8: Mobile as Primary Approval Surface

| # | Issue | Size | Month |
|---|-------|------|-------|
| 8.1 | Push notifications for pending approvals (Tauri native) | L | 2 |
| 8.2 | Approval batching for parallel sessions | M | 2 |

### Epic 9: Session Memory and Resume

| # | Issue | Size | Month |
|---|-------|------|-------|
| 9.1 | Session graph persistence in SQLite | XL | 2-3 |
| 9.2 | Session resume across context rotations | L | 3 |

---

## What to Kill

- **GraphExplorer3D / MemoryLavaLamp** — visual chrome, defer indefinitely
- **AnalyticsPage** — show raw numbers on session cards, don't build a dashboard
- **CortexTaskBoard** — orchestrator packets ARE the task board, don't build two
- **LLM-powered briefings** — models will commoditize this, don't invest
- **Multi-user features** — solo operator only for v1

---

## What Makes o8 Different From the Codex Plugin

The Codex plugin is a feature o8 subsumes. It cannot:
- Govern sessions in other terminals
- Provide mobile approval surfaces
- Persist organizational memory across providers
- Enforce policies across session rotations
- Run parallel delegations with dependency ordering

o8 is the control plane. The plugin is a peer tool.
