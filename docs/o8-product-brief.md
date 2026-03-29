# o8 — Product Brief

## One sentence

o8 is the governance layer for autonomous engineering teams — approvals, audit, organizational memory, and mobile operator control across any AI provider.

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

### 1. Governance layer — trust without reading diffs
Agents are getting autonomous fast. The scarce resource isn't code generation — it's human confidence that the code is safe to ship. o8 is the approval surface: orchestrator review summaries, workflow stage badges, audit trails, and policy enforcement (e.g., "nothing merges without human sign-off on database migrations"). This gets MORE valuable as models improve. Every increment in agent autonomy is an increment in demand for governance. No provider builds this because governance is inherently multi-stakeholder and provider-neutral.

### 2. Organizational memory — user-owned, cross-provider
Provider memory is siloed and provider-owned. Anthropic sees Claude sessions. OpenAI sees Codex sessions. Neither sees the chain: a GitHub issue triaged on your phone that spawned a Claude plan that delegated three Codex worktrees. o8's session graph and Cortex memory layer are the user's data, portable across providers, persistent across sessions, and compounding over time. Switching costs grow with every session logged — not because of lock-in tricks, but because the memory is genuinely valuable and nobody else has it.

### 3. Mobile operator surface — conduct work from anywhere
The phone isn't a notification viewer. It's a control surface: approve merges, steer priorities, deny risky changes, spawn new work. No CLI tool works on mobile, no provider ships a mobile approval flow, and the value is obvious to anyone who's been paged at 2am. As agents need less instruction and more approval, the phone becomes the most natural operator device.

### What is NOT a moat (table stakes only)
- Cost/context dashboards — models get cheaper every quarter
- Briefing/repo scanning — commodity capability any wrapper can add
- Orchestration quality — copyable implementation detail
- Provider neutrality as a pitch — it's infrastructure, not positioning. Never headline "works with Claude AND Codex." Neutrality is plumbing for governance.

## Karpathy alignment

Building on Karpathy's thesis that the IDE is moving up a layer:

| Karpathy says | o8 delivers |
|---|---|
| "The unit of interest is the agent, not the file" | Agent/run/squad as primary UI entity, not file tree |
| "We need a bigger IDE" | Desktop-first control tower, not an editor plugin |
| "Org code" — reusable squad topologies, review chains | Team templates and workflow presets (v2+) |
| "Legible at every zoom level" | Fleet → squad → run → evidence drilldown |
| "Usage, cost, context stats" | Table-stakes visibility (not a differentiator — models get cheaper) |
| "Mobile control with voice" | Mobile operator remote, not a phone IDE |

## v1 scope (solo operator)

### Ships in v1
- Desktop control plane (Next.js + Tauri)
- Opinionated Claude→Codex routing (Claude orchestrates, Codex executes) — v1 wedge, not the durable product
- Workspace lanes with live agent visibility
- **Approval/governance engine** — policy rules, approval queue, audit log, escalation. This is the priority build.
- Orchestrator that plans, delegates, and reviews before anything merges
- Agents work in worktrees, never main
- Mobile surface as the primary approval interface (approve/deny/steer from phone)
- Cortex memory for continuity across sessions and providers
- GitHub integration — issues as intake, PRs as output

### Does NOT ship in v1
- Team features, permissions, shared state (architecture supports it)
- Org code / squad templates
- Managed cloud orchestrator runtime
- Token relay / API key management for end users
- Landing page, public marketing

Architecture supports all of the above. UI doesn't expose it yet.

## Monetization

### Adoption funnel: Free local app
The desktop app is free. Users bring their own CLI plans (Claude Code, Codex). This is the adoption wedge — solo operators fall in love with the control plane and mobile surface. Do not try to monetize individuals competing with free CLI tools.

### Tier 1: Cloud Sync — $15-20/month
Session graph, memory, workspace state synced across devices. This is what makes mobile work. Without it, the phone is disconnected. With it, you pick up your phone and everything is there. This is a conversion funnel to the team tier, not the primary business.

### Tier 2: Team Governance — $25/seat/month (the business)
This is where the money is. Shared approval policies, audit logs, fleet visibility, shared organizational memory, escalation rules. The paying customer is the engineering manager who needs governance over a fleet of agents, not the individual developer. 5 seats at $25 = $125/mo per team. 8,000 teams = $1M ARR. The team path is 8x more capital-efficient than individual subscriptions.

### Tier 3: Managed Orchestrator Runtime — usage-based (future)
Run the orchestrator in the cloud so agents keep working when your laptop is closed. Mobile triggers real work without a desktop running. Pay per orchestrator hour or per agent session spawned.

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
4. **Models get smarter** — Don't build what Claude 5 will do for free. Governance, organizational memory, and the operator approval surface are the layers that get MORE valuable as models improve. Orchestration quality, cost dashboards, and briefing features are commodities — keep them as table stakes, never headline them.

## What we are NOT building

- A VS Code fork or editor
- A code-writing tool (the models do that)
- Anything a single provider will ship natively
- A project management tool
- A CI/CD system
- **Capabilities that models will commoditize** — cost dashboards, context window optimization, prompt engineering tools, orchestration quality, or briefing/summarization features are table-stakes utilities, never headline differentiators. Our moats are governance, organizational memory, and the operator approval surface.

## What we ARE building

The governance layer that sits above all providers — making autonomous engineering teams visible, auditable, approvable, and operable from anywhere.
