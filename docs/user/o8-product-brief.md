# o8 — Product Brief

## One sentence

o8 is the governance layer for autonomous engineering teams: approvals, audit, organizational memory, and mobile operator control across AI providers.

## Why it exists

AI coding tools are powerful but siloed. Each runtime has its own sessions, transcripts, controls, and idea of what happened. Once a developer runs several agents across several tasks, the workflow degrades into scattered terminals, manual context-passing, uncertain ownership, and diffs that arrive faster than anyone can review them.

The current generation helps one developer code faster.
The next generation needs to help one operator manage an **organization of agents**.

o8 sits above the coding agents. It turns work into missions and packets, isolates execution in worktrees, keeps the operator in the approval path, and records enough evidence to explain what happened later.

## Who it is for

o8 is for developers and technical operators who:

- already rely on one or more coding-agent CLIs;
- want several tasks moving without manually coordinating terminals;
- need review and approval controls before agent work reaches the main branch;
- want to inspect, steer, approve, or stop work away from their desk; and
- need project rules and prior outcomes to survive across sessions and runtimes.

The product assumes the models can write code. Its job is to make their work visible, bounded, reviewable, and accountable.

## The operating loop

1. **Connect a repository.** o8 reads the repository state and gives the operator one place to work with its issues, branches, pull requests, and active agent sessions.
2. **Describe the outcome.** An orchestrator turn can work directly or create a mission that divides the request into packets.
3. **Dispatch workers.** Each packet selects a worker runtime and runs in an isolated worktree with its own branch, transcript, lifecycle, and scope.
4. **Watch the work.** Desktop and mobile surfaces show packet state, activity, transcripts, changed files, and recovery events.
5. **Review the evidence.** The operator or orchestrator inspects the diff and review summary before the merge path opens.
6. **Approve, reject, or steer.** Workers cannot merge their own packets. Approval decisions and recovery actions pass through the same governed control plane.
7. **Keep the outcome.** Audit events and reviews remain in o8's history surfaces, while completed session outcomes give Cortex material that later work can retrieve.

## Governance is the product

Agents are becoming more autonomous. The scarce resource becomes human confidence that their code is safe to ship.

o8 provides the approval surface around agent work:

- **Isolation.** Packets execute in worktrees instead of sharing an uncontrolled checkout.
- **Identity and capability boundaries.** Operator, worker, device, and self-authenticating requests have different permissions.
- **Review before merge.** Diffs, review summaries, policy checks, and merge gates keep execution separate from approval.
- **Explicit recovery.** Failed launches, failed merge checks, stalled sessions, and rejected work move through visible states instead of disappearing into a terminal.
- **Audit history.** Lane events and approval records show who requested an action, who approved it, and what happened next.
- **Operator control.** The same governed actions are reachable from desktop, mobile, CLI, and MCP surfaces without giving every caller the same authority.

Better models increase the amount of work one person can start. Governance keeps that work legible enough to trust.

## Organizational memory

Provider transcripts answer what one agent said in one session. Engineering work needs a longer memory: the project rule that changed a review, the failed approach that should not be repeated, the outcome of an earlier packet, and the reason an operator rejected a merge.

Cortex is o8's memory layer. It combines operator-authored directives, repository documentation, and completed-session outcomes. The information stays attached to the project rather than to one model vendor, so an orchestrator and its workers can share the same operating context even when they use different runtimes.

Cortex retrieves evidence and proposes useful context. The operator approves consequential actions and decides which rules become durable.

## Mobile is an operator surface

The phone carries decisions that cannot wait for the desktop. It can show active packets and approval items, open review evidence, send a steering message, approve or reject an action, and follow work while the operator is away.

The mobile UI concentrates on remote control: what is running, what is blocked, what changed, and what needs approval.

## Runs on your subscriptions

The primary local worker adapters launch the installed coding-agent CLIs and reuse the authentication those tools already have. A Claude Code subscription can power Claude Code sessions, a ChatGPT plan can power Codex, and existing Gemini authentication can power Gemini workers.

o8 adds coordination and governance around those tools. The core local loop does not require replacing existing CLI subscriptions with a new metered inference account, and the runtime contract keeps product callers independent of one provider's protocol.

## Architecture direction

```text
Operator on desktop or mobile
  ↓
o8 control plane
  ├── orchestrator backend registry
  ├── missions, packets, lanes, and approvals
  └── Cortex directives and outcomes
          ↓
worker runtime registry
          ↓
isolated worktrees and runtime sessions
          ↓
review evidence → approval → merge gate
```

The orchestrator backend and worker runtime are independent choices. The orchestrator may execute directly or dispatch packets, and a mission can choose the runtime appropriate for each packet. The UI and API consume normalized runtime capabilities rather than vendor-specific session formats.

Local state is SQLite- and file-backed under `~/.o8` by default. The desktop shell resolves local API and WebSocket ports dynamically, and the API is default-deny with explicit credentials and narrow exceptions. These boundaries let the same control plane serve the desktop, mobile devices, the `o8` CLI, and MCP clients without treating every caller as the operator.

## Product direction

o8 follows the Software 3.0 shift from files toward agents and their work. Its primary entities are missions, packets, sessions, reviews, approvals, and outcomes. The interface should let an operator move from the fleet view to one packet and then to the exact evidence behind a decision.

GitHub issues can provide intake and pull requests can carry output. Project management and code editing stay in their existing tools; o8 coordinates those tools and governs the path from intent to merge.

The product should stay focused as the agent ecosystem changes. Runtime-specific behavior belongs behind adapters. Features that generate or summarize code support the loop, while approvals, audit, organizational memory, and operator control define it.

Every packet should end in evidence an operator can inspect, an explicit decision, and an auditable outcome that future work can retrieve.
