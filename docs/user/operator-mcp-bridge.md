# o8 Operator MCP Bridge — What This Unlocks

> **Current transport (2026-07):** the running app hosts the shared operator
> tool registry once at the token-gated streamable-HTTP endpoint `/api/mcp`.
> Client configs launch the thin `operator-mcp-proxy` stdio shim; the standalone
> stdio server remains only for headless use when the app is not running.

## What We Built

An MCP host that turns any compatible client into a remote control for o8. The
dashboard, mobile app, and terminal clients are peer surfaces over the same
execution and governance layer.

```
Terminal (Claude Code)  →  o8_send, o8_status, o8_approve...  →  o8 API  →  Agents
Mobile app              →  WebSocket controller               →  o8 API  →  Agents
Dashboard               →  React UI                           →  o8 API  →  Agents
```

Install and inspect client configuration from Settings → MCP.

---

## What This Unlocks for Us (o8 Devs)

**1. Dogfooding while building.** We can edit o8's source code in Claude Code AND control the running o8 app from the same session. "Launch a Codex agent to fix the auth bug" without switching windows. The dev loop shrinks from alt-tab to one sentence.

**2. Testing the orchestrator without the dashboard.** The MCP bridge hits the same API routes the dashboard uses. If `o8_status` returns wrong data, the dashboard is also wrong — catch bugs at the API layer.

**3. Headless CI/CD agent orchestration.** A scheduled Claude Code session (via OpenClaw heartbeat or cron) can call `o8_send` to launch nightly tasks, `o8_status` to check completion, `o8_approve` to auto-approve safe merges. No dashboard open. No human in the loop for routine work.

**4. The MCP server IS the API contract.** The shared tool registry defines
what an operator can reach from external clients. If a control-plane operation
isn't represented there or in the CLI, the API surface is incomplete.

---

## What This Unlocks for Devs in General

**1. Terminal-native governance.** Power users who live in the terminal get full agent orchestration without opening a GUI. "Ship the PR" from vim. "What happened overnight?" from their morning Claude Code session.

**2. Claude Code becomes an orchestrator.** Any developer with Claude Code can now plan, delegate, monitor, and approve multi-agent work. Claude Code reads the codebase, reasons about what to do, then calls `o8_send` to dispatch agents. The user's Claude Code IS the brain, o8 IS the hands.

**3. Composable agent workflows.** Because these are MCP tools, Claude Code can chain them. "Check status, approve anything that passed CI, reject anything that touched production configs" — Claude Code reads the approvals, makes decisions, calls approve/reject. Autonomous governance with human-set policies.

**4. Session continuity across terminal restarts.** User closes their terminal, reopens next morning, says "what happened?" Claude Code calls `o8_history` — full context of what agents did overnight. The o8 server persists everything. The terminal is ephemeral, the work isn't.

---

## What This Unlocks for Production Users

**1. Three ways in, one system.** Dashboard for visual overview. Mobile for on-the-go approvals. Claude Code for power-user terminal control. Users pick the surface that fits their moment — all three see the same state.

**2. Voice-to-agent pipeline.** Voice → Claude Code dictation → `o8_send("fix the login bug")` → agent launches → dashboard shows progress → mobile pings for approval. The entire loop from intent to shipped code, spoken aloud.

**3. Team-scale delegation without context switching.** A tech lead reviews PRs in their terminal while agents work across 5 repos. `o8_status` gives the fleet view. `o8_approve` merges the clean ones. `o8_reject` sends feedback. All from one Claude Code session.

**4. The invisible IDE.** o8's thesis is "the best IDE is no IDE." The MCP bridge takes this literally — you never open the app. You talk to your agent, your agent talks to o8, work gets done, results appear. The dashboard exists for when you WANT to look, not because you HAVE to.

---

## Tool registry

The shared registry now covers fleet status, missions and packets, review and
merge governance, webview/canvas control, repo-spec annotations, task-pool
operations, and operator defaults. Tool definitions and handlers are registered
once in `src/lib/mcp/operator-mcp-host.ts`; both HTTP and standalone stdio
transports consume that registry.

## Architecture Decision

The user's Claude Code and o8's internal orchestrator are **peers**, not parent-child. Both can launch agents. Both can approve merges. The internal orchestrator handles missions from the dashboard chat. The MCP bridge handles intent from the terminal. They share the same API layer.

This means o8 is not a monolithic IDE — it's a governance API with multiple frontends. The MCP bridge proves the API is complete enough to drive the entire system from a 5-tool interface.

---

*Built 2026-03-30; transport consolidated 2026-07. Current seams:
`src/lib/mcp/operator-mcp-host.ts`, `src/app/api/mcp/route.ts`,
`src/lib/mcp/operator-mcp-proxy.ts`, and
`src/app/api/setup/mcp-config/route.ts`.*
