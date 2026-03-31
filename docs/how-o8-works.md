# How o8 Works

## For Everyone

o8 is a control tower for AI coding agents. Think of it like air traffic control — but instead of planes, you're managing AI workers that write software.

You talk to your personal AI (Claude). Claude turns your words into tasks. o8 breaks those tasks into work packets, assigns them to AI workers (like OpenAI's Codex), watches them work, checks their output for mistakes, and merges the code when it's safe. All of this happens in parallel — multiple workers building different parts at the same time.

**The key idea:** You say what you want built. The system figures out how to build it, who builds what, in what order, and whether the result is safe to ship.

### What makes o8 different from just using an AI coding tool?

When you use ChatGPT or Claude to write code, it's like having one assistant. You tell them what to do, they do it, you check it, repeat.

o8 is like having a **team** of assistants with a **manager** (Claude) and a **policy manual** (the governance layer). The manager breaks work into pieces, assigns them in the right order, watches for problems, and makes sure nothing ships without review. If one assistant makes a mistake, the manager catches it and fixes it before the code goes live.

### The trust problem

The #1 question with AI writing code is: "How do I know this is safe?" o8's answer:

- **Policy engine** — 12 rules that flag risky actions (deleting files, running destructive commands, pushing to protected branches)
- **Approval gates** — Certain actions require human sign-off before they execute
- **Audit trail** — Every decision is logged. You can prove what your agents did and why
- **Structured diffs** — Before any merge, you see exactly what changed, file by file
- **Review findings** — The orchestrator's code review is recorded as a governance event, not just a conversation

---

## For Developers

### Architecture

```
┌─────────────────────────────────────────────────┐
│  Operator Surfaces                               │
│  ┌──────────┐ ┌────────┐ ┌─────┐ ┌───────────┐ │
│  │ Desktop  │ │ Mobile │ │ MCP │ │ API/CLI   │ │
│  │ (Tauri)  │ │ (Web)  │ │     │ │ (headless)│ │
│  └────┬─────┘ └───┬────┘ └──┬──┘ └─────┬─────┘ │
│       └────────────┴────────┴───────────┘       │
│                      │                           │
│              ┌───────▼────────┐                  │
│              │  Orchestrator  │                  │
│              │  ┌───────────┐ │                  │
│              │  │ DAG       │ │  Packets with    │
│              │  │ Scheduler │ │  dependency      │
│              │  └───────────┘ │  ordering         │
│              │  ┌───────────┐ │                  │
│              │  │ Headless  │ │  Continuous       │
│              │  │ Loop      │ │  dispatch cycle   │
│              │  └───────────┘ │                  │
│              │  ┌───────────┐ │                  │
│              │  │ Context   │ │  Cross-session    │
│              │  │ Relay     │ │  memory passing   │
│              │  └───────────┘ │                  │
│              └───────┬────────┘                  │
│                      │                           │
│              ┌───────▼────────┐                  │
│              │ Lane Command   │  9 verbs:        │
│              │ Bus            │  open, launch,   │
│              │                │  pause, resume,  │
│              │ ┌────────────┐ │  interrupt, PR,  │
│              │ │ Policy     │ │  merge, release, │
│              │ │ Engine     │ │  close           │
│              │ └────────────┘ │                  │
│              └───────┬────────┘                  │
│                      │                           │
│              ┌───────▼────────┐                  │
│              │  Supervisor    │  Watches agents:  │
│              │                │  stuck detection, │
│              │                │  retry, progress, │
│              │                │  completion       │
│              └───────┬────────┘                  │
│                      │                           │
│         ┌────────────┴────────────┐              │
│         │                         │              │
│  ┌──────▼──────┐          ┌──────▼──────┐       │
│  │ Claude Code │          │   Codex     │       │
│  │ Adapter     │          │   Adapter   │       │
│  │ (tmux)      │          │   (owned)   │       │
│  └─────────────┘          └─────────────┘       │
│                                                  │
│  Runtime adapters are pluggable. Any LLM agent   │
│  that can run in a terminal can be added.        │
└─────────────────────────────────────────────────┘
```

### Core Concepts

**Packet** — A unit of work. Has a title, prompt, runtime target, workspace path, and dependency list. Packets form a DAG (directed acyclic graph) where dependencies must complete before dependents can start.

**Lane** — A durable binding between a repo, worktree, runtime session, and packet. Lanes have a lifecycle: `idle → launching → running → reviewing → completed/merged`. The lane command bus is the single entry point for all lane operations — never call runtime adapters directly.

**Mission** — A collection of packets with a shared goal. Missions have a DAG structure where packets execute in waves: wave 1 (no dependencies) runs in parallel, wave 2 (depends on wave 1) starts when wave 1 completes, etc.

**Approval** — A governance checkpoint. When a policy rule triggers, an approval is created with context (diff, risk level, description). Approvals can be resolved by humans (desktop/mobile) or by the orchestrator (with findings recorded).

### The Sprint Workflow

This is how o8 was used to build itself (21 issues in one session):

```
1. Claude reads GitHub issues
2. Claude calls create_mission(issues) via MCP
3. o8 creates packets with DAG ordering
4. Claude calls dispatch_mission() via MCP
5. DAG scheduler launches wave 1 (up to 4 parallel agents)
6. Each agent gets its own git worktree (isolated)
7. Supervisor monitors progress via transcript polling
8. Agent completes → supervisor detects → auto-review triggers
9. Context relay captures summary + changed files
10. Claude audits diff → submit_review(findings) via MCP
11. Wave 2 packets get dependency context injected into prompts
12. Repeat until all waves complete
13. Claude calls approve_and_merge() through policy engine
```

### MCP Tools (for agent operators)

The MCP server at `src/lib/mcp/operator-mcp-server.ts` exposes 10 tools:

**Original 5 (session-level):**
- `send` — Send a message to a runtime session
- `status` — Get fleet status
- `approve` — Approve a pending approval
- `reject` — Reject a pending approval
- `history` — Get approval history

**Sprint 5 additions (mission-level):**
- `create_mission` — Create packets from GitHub issues with DAG ordering
- `dispatch_mission` — Trigger the DAG scheduler
- `get_mission_status` — Wave progress, agent states, cost
- `submit_review` — Record orchestrator review findings as governance events
- `approve_and_merge` — Approve through policy engine, trigger merge

### Key Files

| File | Purpose |
|------|---------|
| `src/lib/orchestrator/dispatch.ts` | DAG dispatch with parallel execution |
| `src/lib/orchestrator/dag.ts` | Wave computation, dependency graph |
| `src/lib/orchestrator/context-relay.ts` | Cross-session memory passing |
| `src/lib/orchestrator/headless-loop.ts` | Continuous dispatch without human |
| `src/lib/orchestrator/cost-aggregator.ts` | Per-packet/mission cost rollup |
| `src/lib/supervisor/agent-supervisor.ts` | Zero-LLM-cost agent monitoring |
| `src/lib/lane/commands.ts` | 9-verb command bus with policy gates |
| `src/lib/approvals/policies.ts` | 12-rule policy engine, hot-reload |
| `src/lib/approvals/store.ts` | Approval CRUD + orchestrator review |
| `src/lib/mcp/operator-mcp-server.ts` | MCP bridge for agent operators |
| `src/lib/runtimes/claude-code.ts` | Claude Code adapter (tmux spawn) |
| `src/lib/runtimes/codex.ts` | Codex adapter (owned sessions) |
| `src/lib/hooks/claude-code-pretool-hook.ts` | PreToolUse policy enforcement |

### What's Left

| Area | Issues | Status |
|------|--------|--------|
| Skills system | #327-329 | P2, not started |
| Session persistence (SQLite) | #330 | P2, not started |
| Supervisor fleet scaling | #338 | P1, not started |
| UI polish (logo, colors, glass) | #298, #304-307 | Backlog |
| Workspace env compatibility | #288 | P2, not started |

### The Governance Moat

What makes o8 defensible isn't any single feature. It's the combination:

1. **Session graph** — Every agent session, every transcript, every diff, every review finding is connected. This is organizational memory that compounds over time.
2. **Provider neutrality** — Claude orchestrates, Codex executes, but the lane/packet/approval model works with any LLM that can run in a terminal. When the next model drops, o8 adds an adapter.
3. **Policy engine** — 12 rules, 3 risk tiers, per-workspace config, hot-reload. This is the answer to "how do enterprises trust AI agents?" You configure your policies, o8 enforces them.
4. **Cross-session context** — When Agent A finishes and Agent B starts, B gets A's summary, review findings, and file conflict warnings. No single provider builds this because they can't see across provider boundaries.
