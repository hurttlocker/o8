# Cortex Memory Integration — Design Spec

## The Problem

Every coding agent IDE on the market is stateless. Sessions start from zero. Agents don't know what happened yesterday. Users can't see why their codebase looks the way it does. Institutional knowledge lives in people's heads, scattered docs, and Slack threads — never in the tool where the work happens.

## What Cortex Memory Adds

Cortex is a local-first memory system with Ebbinghaus confidence decay, hybrid search (BM25 + semantic), structured fact extraction, and a knowledge graph. It runs as a single Go binary with SQLite storage. No cloud dependency. No data leaves the machine.

Integrating Cortex into Cortex IDE means the IDE becomes the first coding agent orchestrator with persistent, searchable, decaying institutional memory — memory that gets smarter over time and warns you when it's contradicting itself.

## Five Surfaces

### 1. Recall Panel

**What it does:** Shows relevant Cortex facts for whatever you're currently looking at.

**User experience:** You're viewing an agent session working on your auth layer. The recall panel slides in from the right showing 3–5 cards:
- "JWT chosen over session cookies — mobile API requirement" (decision, 94% confidence, 3 weeks old)
- "Auth token refresh uses single-use rotation" (state, 88% confidence, 2 weeks old)
- "Never store tokens in localStorage — use httpOnly cookies" (preference, 97% confidence)

Each card shows: fact text, type badge (decision/preference/state/config), confidence bar, age, source attribution ("from memory/2026-02-28.md, line 142").

**Tap a card** → expands to show:
- Full source quote
- Provenance: which agent wrote it, when, from what session
- "Reinforce" button (resets decay timer)
- "Retire" button (marks as no longer relevant)
- "Inject" button (copies fact into the compose bar as agent context)

**Technical implementation:**
```
User views session → IDE extracts context (repo, branch, task description)
  → POST /api/mobile/cortex/recall { query, limit: 5 }
  → Server runs: cortex search "<query>" 5 --json
  → Returns fact cards with confidence, source, type
  → Rendered as CollapsibleCard components (inline styles, iOS Safari safe)
```

**Query strategy:** Combine repo name + branch + current task into a search query. Example: `"cortex-ide auth layer JWT token refresh"`. Cortex's hybrid search handles relevance ranking.

### 2. Memory Health Dashboard

**What it does:** System monitor for institutional knowledge. Answers: "How healthy is our memory? What's fading? What's contradicting itself?"

**User experience:** Accessible from the controls sheet (hamburger menu). Shows:

**Hero card:**
- Total facts count (e.g., "36,631 facts")
- Confidence distribution donut (high/medium/low)
- Growth rate ("540 new memories in last 24h")

**Sections:**

**Stale Queue** — Facts with decaying confidence that need attention:
- "API versioning uses /v2 prefix" — 62% confidence, fading
- Tap → Reinforce (keep it) or Retire (let it go)
- Badge count on hamburger menu when stale facts > 5

**Conflicts Queue** — Contradictory facts Cortex detected:
- "Fact A: Use REST for public API" vs "Fact B: Use GraphQL for public API"
- Tap → Pick the correct one. Loser gets superseded.
- Badge count (red) when conflicts > 0

**Agent Memory Breakdown** — Per-agent fact counts:
- Niot: 2,400 facts (Cortex development)
- Hawk: 800 facts (QA patterns)
- Mister: 12,000 facts (everything)

**Technical implementation:**
```
POST /api/mobile/cortex/health
  → Server runs: cortex stats --json (health overview)
  → Server runs: cortex stale --limit 10 --json (fading facts)
  → Server runs: cortex conflicts --limit 5 --json (contradictions)
  → Parallel Promise.all, single response
```

### 3. Pre-Launch Context Injection

**What it does:** Before an agent starts a task, Cortex automatically surfaces relevant past decisions, preferences, and constraints. The agent doesn't start from zero — it starts from what the team already knows.

**User experience:** You type a prompt in the compose bar: "Refactor the payment processing module to support Stripe." Before sending, the IDE shows a "Memory context" section below the compose bar:

- 📋 3 relevant facts found
- "Payment processing uses idempotency keys" (decision)
- "Stripe webhook signature verification is required" (config)
- "All payment amounts stored as cents (integer)" (preference)

Toggle: "Include memory context" (on by default). These facts are prepended to the agent's system context as a `[INSTITUTIONAL_MEMORY]` block.

**Technical implementation:**
```
User types prompt → debounced search (500ms after typing stops)
  → POST /api/mobile/cortex/context { prompt, cwd, branch }
  → Server runs: cortex search "<prompt + repo context>" 5 --json
  → Returns fact summaries
  → On send: facts prepended to prompt as structured context block

Context block format (sent to agent):
---
[INSTITUTIONAL MEMORY — from Cortex]
The following facts are relevant to this task:
1. [decision] Payment processing uses idempotency keys (94% confidence)
2. [config] Stripe webhook signature verification is required (91% confidence)
3. [preference] All payment amounts stored as cents, integer (97% confidence)
Consider these when making implementation decisions.
---
<user's actual prompt>
```

**Why this matters:** This is the feature that makes agents compound. Every session builds on every previous session. An agent that has never touched your payments code still knows your team's conventions before writing line one.

### 4. Conflict Resolution UI

**What it does:** Cortex automatically detects contradictory facts. The IDE surfaces them as actionable cards instead of letting silent contradictions poison agent context.

**User experience:** A notification badge appears on the memory health icon. You tap it and see:

**Conflict card:**
```
⚠️ Contradicting facts detected

Fact A: "API responses use camelCase" 
  → from Niot, March 3, 2026 (89% confidence)

Fact B: "API responses use snake_case"
  → from Hawk, March 8, 2026 (92% confidence)

[Keep A]  [Keep B]  [Keep Both]  [Dismiss]
```

Tapping "Keep B" → Fact A gets superseded (`cortex supersede <factA_id>`). The winning fact gets reinforced. The conflict disappears.

**Technical implementation:**
```
POST /api/mobile/cortex/conflicts
  → Server runs: cortex conflicts --limit 10 --json
  → Returns pairs of contradicting facts with IDs

POST /api/mobile/cortex/resolve
  → Body: { keepId: 12345, supersededId: 12346 }
  → Server runs: cortex supersede <supersededId>
  → Server runs: cortex reinforce <keepId>
```

### 5. Knowledge Graph Explorer

**What it does:** Visual map showing how decisions, preferences, and facts connect to each other. Answers: "Why is our codebase the way it is?"

**User experience:** Tap a fact in the recall panel → "Show connections" → Graph view opens:

Center node: "JWT chosen over session cookies"
Connected to:
- "Mobile API requirement" (reason)
- "Auth token refresh uses single-use rotation" (consequence)  
- "Never store tokens in localStorage" (related preference)
- "Auth layer refactored March 2026" (temporal context)

Tap any node to center on it and explore further. Pinch to zoom. Drag to pan.

**Impact analysis:** Tap "Impact" on any node → shows blast radius. "If we change from JWT to session cookies, these 7 facts would need updating."

**Technical implementation:**
```
POST /api/mobile/cortex/graph
  → Body: { factId: 12345 } or { subject: "JWT" }
  → Server runs: cortex graph_explore "JWT" --json
  → Returns nodes + edges

POST /api/mobile/cortex/impact
  → Body: { subject: "JWT auth" }
  → Server runs: cortex graph_impact "JWT auth" --json
  → Returns affected facts with relationship paths

Rendering: D3 force-directed graph or react-force-graph
  → Nodes: facts (colored by type)
  → Edges: relationships (labeled)
  → Mobile: simplified list view with indentation for depth
```

## Data Flow Architecture

```
┌─────────────────────────────────────────────────┐
│                  Cortex IDE UI                   │
│                                                  │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────┐ │
│  │ Recall   │ │ Health   │ │ Pre-launch       │ │
│  │ Panel    │ │ Dashboard│ │ Context Injection │ │
│  └────┬─────┘ └────┬─────┘ └───────┬──────────┘ │
│       │             │               │             │
│  ┌────┴─────────────┴───────────────┴──────────┐ │
│  │        Next.js API Routes                    │ │
│  │  /api/mobile/cortex/{recall,health,context,  │ │
│  │   conflicts,resolve,graph,impact}            │ │
│  └──────────────────┬──────────────────────────┘ │
└─────────────────────┼───────────────────────────┘
                      │
                      │ execFile('cortex', [...args, '--json'])
                      │
              ┌───────┴───────┐
              │  Cortex CLI   │
              │  ~/bin/cortex │
              │               │
              │  search       │
              │  stats        │
              │  stale        │
              │  conflicts    │
              │  reinforce    │
              │  supersede    │
              │  graph_explore│
              │  graph_impact │
              │  answer       │
              └───────┬───────┘
                      │
              ┌───────┴───────┐
              │  SQLite DB    │
              │  ~80MB        │
              │  36K+ facts   │
              │  20K memories │
              └───────────────┘
```

**Why CLI over MCP?** Simpler. The MCP server is great for agent-to-agent communication, but for IDE → Cortex, `execFile('cortex', ['search', query, '5', '--json'])` is a single async call that returns JSON. No connection management, no protocol overhead. Same pattern we use for `openclaw status --json`.

**Future upgrade path:** If latency matters (graph explorer, real-time search), switch to `cortex mcp --port 8080` and use HTTP+SSE. The API routes don't change — only the server-side transport.

## Implementation Plan

### Phase 1: Recall + Health (Issues #14, #15)

**New files:**
```
src/lib/cortex/
├── client.ts          # CLI wrapper: execFile('cortex', ...) + JSON parse
├── types.ts           # CortexFact, CortexConflict, CortexStats, etc.
└── cache.ts           # In-memory cache with TTL (stats don't change every second)

src/app/api/mobile/cortex/
├── recall/route.ts    # Search facts by context
├── health/route.ts    # Stats + stale + conflicts
└── resolve/route.ts   # Reinforce / supersede / retire

src/components/mobile/
├── RecallPanel.tsx     # Fact cards with confidence bars
├── MemoryHealth.tsx    # Stats donut + stale/conflict queues
└── FactCard.tsx        # Individual fact with actions
```

**Estimated size:** ~600–800 lines total across all files.

### Phase 2: Pre-Launch Context Injection

**Modified files:**
- `ComposeBar.tsx` — add memory context preview below compose input
- `controller-compose.ts` — query Cortex on prompt change (debounced)
- Launch flow — prepend institutional memory block to agent prompt

**Estimated size:** ~200 lines of new code.

### Phase 3: Conflict Resolution + Graph

**New files:**
```
src/components/mobile/
├── ConflictCard.tsx     # Side-by-side fact comparison with resolve actions
└── GraphExplorer.tsx    # Force-directed graph or tree view

src/app/api/mobile/cortex/
├── graph/route.ts       # Graph explore + impact
└── conflicts/route.ts   # (could merge with health)
```

**Estimated size:** ~400–600 lines. Graph explorer is the most complex component.

## Cortex CLI Requirements

Everything needed already exists in Cortex v1.2.4:

| IDE Feature | Cortex Command | Exists? |
|---|---|---|
| Recall search | `cortex search "<query>" <limit> --json` | ✅ |
| Stats overview | `cortex stats --json` | ✅ (returns JSON by default) |
| Stale facts | `cortex stale --limit N --json` | ✅ |
| Conflicts | `cortex conflicts --limit N --json` | ✅ (returns JSON) |
| Reinforce fact | `cortex reinforce <id>` | ✅ |
| Supersede fact | `cortex supersede <id>` | ✅ |
| Retire fact | `cortex beliefs set retired <id>` | ✅ |
| Graph explore | `cortex graph_explore "<subject>" --json` | ✅ (via MCP) |
| Graph impact | `cortex graph_impact "<subject>" --json` | ✅ (via MCP) |
| Answer synthesis | `cortex answer "<query>" --json` | ✅ |

**Potential gaps to verify:**
- `cortex stale` — confirm `--json` flag outputs structured JSON (not just text)
- `cortex graph_explore` — may only be available as MCP tool, not CLI subcommand
- `cortex conflicts` — verify JSON output includes fact IDs for resolution actions
- Agent-scoped queries (`--agent <id>`) — test with multiple agent IDs

## Competitive Landscape

| Feature | Cursor | Windsurf | Claude Code | Cortex IDE |
|---|---|---|---|---|
| Agent sessions | ✅ | ✅ | ✅ | ✅ |
| Multi-agent orchestration | ❌ | ❌ | ✅ (subagents) | ✅ (any runtime) |
| Session memory | ❌ | ❌ | ❌ | ✅ **Cortex** |
| Cross-session recall | ❌ | ❌ | ❌ | ✅ **Cortex** |
| Decision provenance | ❌ | ❌ | ❌ | ✅ **Cortex** |
| Confidence decay | ❌ | ❌ | ❌ | ✅ **Cortex** |
| Conflict detection | ❌ | ❌ | ❌ | ✅ **Cortex** |
| Knowledge graph | ❌ | ❌ | ❌ | ✅ **Cortex** |
| Pre-launch context | ❌ | Partial | Partial | ✅ **Cortex** |

**The moat:** Memory is a compounding advantage. Every day a user runs Cortex IDE, the memory gets deeper. Switching to Cursor means losing all institutional knowledge. That's lock-in through value, not through vendor lock.
