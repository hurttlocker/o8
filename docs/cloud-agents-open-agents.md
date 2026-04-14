# Cloud Agent Execution — Vercel Open Agents

**Status:** research / pre-integration
**Captured:** 2026-04-14
**Trigger:** Nico Albanese (Vercel AI SDK) open-sourced Open Agents — a reference app for running durable coding agents on Vercel Workflows + Vercel Sandbox.
**Links:**
- https://open-agents.dev
- https://github.com/vercel-labs/open-agents
- https://x.com/nicoalbanese10/status/2043745569278251112
- Vercel Agentic Infrastructure blog — https://vercel.com/blog/agentic-infrastructure

## Why this matters for o8

o8's current execution model is local-only: the Tauri desktop app spawns Codex / Claude Code CLI processes in git worktrees under `~/.cortex-worktrees/*`, streams output through the WebSocket server on port 3002, and the operator's laptop has to stay open for the agent to keep running. That's fine for a solo dogfood loop but it's the single biggest blocker for "24/7 dispatch" — the thing that makes o8 valuable as a governance layer for remote teams.

Open Agents is Vercel's reference for exactly this pivot:

- **Vercel Workflows** — durable, resumable execution. An agent can run for hours while the operator closes the app, restarts their laptop, or hands off to a teammate. Workflows checkpoint automatically and pick up where they left off.
- **Vercel Sandbox** — isolated ephemeral VMs for tool execution (file I/O, shell, git). Replaces the local worktree model. Each dispatch gets its own sandbox.
- **Decoupled agent + sandbox** — the agent process lives outside the VM and calls tool APIs into the sandbox over HTTP. Clean separation means the agent can retry / resume / re-plan without rebuilding the tool surface each time.

## Mapping onto o8's architecture

o8 already has a `runtime adapter` contract (`src/lib/runtimes/types.ts`). The two existing adapters — `codex.ts` and `claude-code.ts` — both satisfy `AgentRuntime` with `discover / launch / resume / interrupt / reviewDiffs`. Adding a third adapter `vercel-workflows.ts` that routes launches through a Vercel Workflow instead of a local CLI is the natural integration point:

- `launch()` → create a Vercel Workflow Run, seed it with the packet prompt, return the workflow run ID as the `sessionKey`
- `discover()` → list active workflow runs for the operator's org, mirror them as surfaces
- `resume()` → send a steer message as a new workflow step (Workflows support appending input)
- `interrupt()` → cancel the workflow run
- `reviewDiffs()` → fetch the sandbox's current branch diff via the Sandbox API

The rest of the governance layer — lanes, approvals, reaper, merged banner, history drawer — is runtime-agnostic. It doesn't care whether the session is Codex-in-a-worktree or Vercel-workflow-in-a-sandbox. When this adapter lands, every existing UI feature "just works" for cloud execution.

## Key constraints from Vercel

| Constraint | Impact |
|---|---|
| **5-minute workflow timeout** | Long refactors need chunking — workflow steps or nested runs. |
| **Sandbox cold start** | ~1–2s spin-up. Acceptable for dispatch-scale work but slower than local PTY. |
| **~30min idle hibernation** | Sandboxes suspend when idle; resume requires re-downloading snapshot. |
| **Fixed port exposure** | Preview ports are hardcoded (3000, 5173, 4321, 8000). Dev servers binding random ports won't preview. |
| **Cost per sandbox** | ~$0.02/mo per active sandbox + workflow execution cost. Local model is zero-cost. |
| **Request body limit** | 4.5MB per step — large context injections need chunking. |

## Gaps we'd need to fill on top of Open Agents

Open Agents is a single-user reference app. o8 needs:

1. **Team / org isolation** — o8 has `teams` + `team_members`. Need to namespace workflow runs and sandboxes per team so one operator can't see another's dispatch.
2. **Approval gates** — o8's review workflow has human-in-the-loop approvals before merge. Vercel Workflows don't natively enforce this; we'd add a workflow pause step that waits on an approval webhook from o8.
3. **Per-team cost attribution** — Vercel doesn't break down cost by tenant. Would need to poll the Vercel API for workflow run metrics and store them in an o8 accounting table.
4. **Branch policy + reaper parity** — the current lane reaper (Case 1/2/3) needs to reach into Vercel-hosted branches too, not just local git worktrees.

## Integration path (when we're ready)

1. Pilot `vercel-workflows.ts` adapter behind a Settings → Runtime toggle. Default stays local.
2. Wire packet dispatch to route through the new adapter when cloud mode is on.
3. Reuse the existing WebSocket stream for state updates by piping Vercel Workflow events into our realtime publisher.
4. Ship approval gate via workflow pause + webhook.
5. Ship cost attribution polling once usage is non-trivial.
6. Start a Vercel partnership conversation — Open Agents is their flagship agentic product; integrating o8 is a plausible co-marketing angle.

## When not yet

The cost of moving to cloud is real (~$0.02/mo per sandbox + workflow exec) and the 5-min timeout is a legitimate constraint. Don't pivot until there are 3+ operators dogfooding daily and "must keep laptop open" is blocking real work. Until then, the local worktree model is free, faster, and matches the single-user dogfood loop.
