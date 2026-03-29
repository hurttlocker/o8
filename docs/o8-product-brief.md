# o8 — Product Brief

## One sentence

o8 is a multi-provider agent control plane that lets one operator orchestrate Claude + Codex from desktop or phone — so you get more compute, safer merges, and never burn one provider's context doing work another could handle.

## The problem

AI coding tools are powerful but siloed. Every tool locks you into one provider, one model, one session at a time. Once you need more than that — running Claude and Codex together, watching multiple agents, conducting work from your phone — the workflow degrades into scattered terminals, manual context-passing, and burned-through plans.

The current generation helps one developer code faster.
The next generation needs to help one operator manage an **organization of agents**.

## Who it's for

Developers and technical operators who:
- Already use Claude Code and/or Codex CLI
- Want to run both simultaneously without manual coordination
- Want to conduct engineering sessions from their phone at 2am
- Are frustrated that Cursor, VS Code, and terminal-only tools limit them to one provider at a time
- Need more compute than a single plan provides

They're coming from Cursor, terminal-only Claude Code, VS Code with Copilot, or some combination. They all land here with the same problem: **I want Claude to work with Codex, not against my usage limits.**

## What it does

**Claude is the brain. Codex is the workhorse. The user talks to o8.**

- Claude always orchestrates — reads the codebase, makes the plan, reviews the output, maintains rhythm
- Codex always executes — runs scoped tasks in worktrees, never touches main, produces diffs
- The user never thinks about which model does what. o8 routes work correctly by default
- Advanced users can override routing for specific tasks

**All runtimes are CLI-based** — not API. o8 uses the actual Claude Code CLI and Codex CLI through a universal runtime adapter system. When a new provider ships a CLI, we add an adapter.

## The first 60 seconds

1. Open o8. One text field. The orchestrator says: *"Point me at a repo and tell me what you're working on."*
2. User connects a repo (local path or GitHub one-click).
3. o8 scans — git history, open issues, recent PRs, branch state.
4. The orchestrator gives a **briefing**: "You have 12 open issues, 3 stale PRs, your main branch is 4 commits ahead of production. Here's what I'd prioritize."
5. Memory fills up naturally from that first interaction. No configuration wizard.

## Why it wins (moats)

### 1. Provider neutrality
The only tool that makes Claude and Codex (and future runtimes) work together as a coordinated team. Anthropic won't build "use Codex as your workhorse." OpenAI won't build "use Claude as your brain." Neither has incentive to make the other a first-class citizen. o8 is Switzerland.

### 2. Session graph — cross-provider state
When a Codex session was spawned by Claude responding to a GitHub issue triaged from your phone — that chain of context lives in o8. Not in Anthropic's servers, not in OpenAI's. No provider has the cross-session memory. They each only see their piece.

### 3. Workflow layer — battle-tested orchestration
The orchestrator-to-worktree-to-review pipeline, the lane model, the mobile inbox, the lifecycle system — these patterns came from actually running a multi-agent engineering org. Not from a design sprint. Every week the system runs, the workflow gets more refined in ways that are hard to reverse-engineer.

### 4. Trust UX — legibility without reading code
The product that wins isn't the one with the best diff viewer — it's the one that makes you not need it. Workflow stage badges, orchestrator review before merge, lifecycle tracking. Trust through progressive disclosure at every zoom level:
- **Fleet** — all agents at a glance
- **Squad** — grouped agents on related work
- **Run** — single agent's current task, status, progress
- **Evidence** — why the agent made this decision, traced through memory

## Karpathy alignment

Building on Karpathy's thesis that the IDE is moving up a layer:

| Karpathy says | o8 delivers |
|---|---|
| "The unit of interest is the agent, not the file" | Agent/run/squad as primary UI entity, not file tree |
| "We need a bigger IDE" | Desktop-first control tower, not an editor plugin |
| "Org code" — reusable squad topologies, review chains | Team templates and workflow presets (v2+) |
| "Legible at every zoom level" | Fleet → squad → run → evidence drilldown |
| "Usage, cost, context stats" | Provider arbitrage visibility — show savings across Claude + Codex |
| "Mobile control with voice" | Mobile operator remote, not a phone IDE |

## v1 scope (solo operator)

### Ships in v1
- Desktop control plane (Next.js + Tauri)
- Opinionated Claude→Codex routing (Claude orchestrates, Codex executes)
- Workspace lanes with live agent visibility
- Orchestrator that plans, delegates, and reviews before anything merges
- Agents work in worktrees, never main
- Mobile surface for conducting sessions from anywhere
- Cortex memory for continuity across sessions and providers
- GitHub integration — issues as intake, PRs as output
- Cost/context visibility across providers

### Does NOT ship in v1
- Team features, permissions, shared state
- Org code / squad templates
- Managed cloud orchestrator runtime
- Token relay / API key management for end users
- Landing page, public marketing

Architecture supports all of the above. UI doesn't expose it yet.

## Monetization

### Tier 1: Cloud Sync — $15-20/month
Session graph, memory, workspace state synced across devices. This is what makes mobile work. Without it, the phone is disconnected. With it, you pick up your phone and everything is there. Real infrastructure cost that justifies the price.

### Tier 2: Team Context Layer — $25/seat/month (future)
The 5-person team scenario. Shared orchestrator context, shared agent visibility, shared issue pipeline. "Everyone knows automatically in context." Org code lives here — reusable squad templates, review chains, escalation rules.

### Tier 3: Managed Orchestrator Runtime — usage-based (future)
Run the orchestrator in the cloud so agents keep working when your laptop is closed. Mobile triggers real work without a desktop running. Pay per orchestrator hour or per agent session spawned.

### Not the core business but possible
Token relay as convenience tax — for users who don't want to configure API keys. Small margin on tokens. Race to zero, so not a primary strategy.

## Connector philosophy

**Connect to surfaces where signal originates.** Discord, Slack, GitHub — places where someone says "this is broken" and that signal needs to become agent work.

**Don't connect to destinations.** No Linear clone, no Notion clone, no Jira integration. If a team uses Linear, they pipe Linear webhooks to GitHub issues (Linear already does this). GitHub is the intake surface. o8 stays one integration deep.

## Naming

- **o8** — the product (orchestrator + infinity). Desktop app, mobile app, everything user-facing.
- **Cortex** — the memory layer. Stays as the underlying memory/recall system.
- **Domains** — o8.dev (product), o8.run (cloud runtime endpoint)

## Architecture (already built)

```
User (desktop or mobile)
  ↓
o8 control plane
  ↓
Runtime adapter registry
  ├── Claude Code adapter (orchestrator)
  ├── Codex adapter (workhorse)
  ├── OpenClaw adapter (gateway sessions)
  └── [future adapters]
  ↓
Worktrees (isolated branches, never main)
  ↓
Orchestrator review → merge
```

### Key technical decisions locked
- CLI-based runtimes, not API
- Inline styles only (no CSS classes — iOS Safari reliability)
- Lucide icons only (no emoji)
- WebSocket RPC for gateway communication (not CLI — it hangs)
- Webpack for dev (not turbopack — HMR stability)
- All work on main branch (rapid iteration mode)

## Risks

1. **Provider dependency** — Either provider could change CLI, pricing, or capabilities overnight. Mitigated by the runtime adapter abstraction.
2. **Too broad too early** — Easy to build editor + PM tool + observability tool + memory tool simultaneously. Stay focused on the control plane.
3. **Self-hosting pain** — Building the tool that builds itself means every code change triggers reloads that kill live state. Accept this until Tauri native shell stabilizes the experience.
4. **Models get smarter** — Don't build what Claude 5 will do for free. Build the layer no single provider can offer: cross-provider orchestration, the session graph, the trust UX.

## What we are NOT building

- A VS Code fork or editor
- A code-writing tool (the models do that)
- Anything a single provider will ship natively
- A project management tool
- A CI/CD system

## What we ARE building

The control plane that sits above all providers and makes them work together — visible, steerable, safe, and operable from anywhere.
