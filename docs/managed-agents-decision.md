# Managed Agents — o8 Adoption Decision Memo

Produced 2026-04-18 as part of epic #589. Spike output for #593.

## Context

Anthropic Managed Agents (currently beta / research preview) is a hosted
agent harness that exposes:

- Agent loop execution (the model call → tool dispatch → result fold cycle
  is hosted on Anthropic infrastructure)
- Sandboxed tool execution
- Per-session file-system persistence
- Built-in compaction (auto-summarize at context limit)
- Multi-agent coordinator → specialized agent routing
- `always_ask` tool confirmation primitive

On paper, this could replace large portions of o8's custom plumbing:
the lane state machine, the orchestrator → codex dispatch loop, the
manual context-relay code, and the compaction passes we ship today.

## What Managed Agents would replace in o8

| o8 subsystem | Equivalent in Managed Agents |
|---|---|
| `src/lib/lane/*` (lane state, dispatch, merge) | Coordinator-agent `call_agent` tool routing |
| `src/lib/orchestrator/dispatch.ts` | Coordinator turn — model decides when to call workers |
| `src/lib/orchestrator/context-relay.ts` | Built-in session persistence |
| `src/lib/orchestrator/auto-compact.ts` | Built-in compaction at context limit |
| Per-runtime adapters (`codex.ts`, `claude-code.ts`) | Worker agents defined in Anthropic harness config |
| Approval gate (`createApproval`) | `always_ask` tool confirmation |

The orchestrator would become a coordinator agent. Codex sessions would
become callable worker agents. Lanes go away as a concept — Anthropic
owns the session thread.

## What we'd lose

This is the load-bearing part of the decision.

1. **Governance hooks.** Our approval surface (`src/lib/approvals/`) is
   the entire product moat. `always_ask` is a single-tool primitive; it
   does not carry our policy engine, risk scoring, audit ledger, or
   mobile operator handoff. Switching means rebuilding all of that on
   top of a less expressive API — or losing it entirely.
2. **Policy engine + audit trail.** The DB-backed `usage_logs`,
   `approvals`, `session_outcomes`, `lanes` tables are Cortex v2's
   organizational memory. Managed Agents owns persistence — we'd be
   reading from Anthropic's session API, not from our own SQLite ledger.
   Loss of provenance kills the audit story.
3. **Multi-runtime portability.** o8 ships adapters for Codex, Claude
   Code, and (future) opencode / OpenRouter / local models. Managed
   Agents only orchestrates Claude. Adopting it locks the orchestrator
   to one provider.
4. **Worktree governance.** Our packet-level worktree isolation, rebase
   ordering, conflict escalation, and parallel merge strategy live in
   `src/lib/lane/commands.ts` + `src/lib/orchestrator/scheduling.ts`.
   None of that maps to a Managed Agents primitive.
5. **Cost predictability.** Anthropic has not published Managed Agents
   pricing. Likely Messages API + infrastructure fee. Until pricing is
   public, we can't model the unit economics — and our cost dashboards
   already give operators full transparency.

## Recommendation

**Skip for now.** Re-evaluate when:

- Managed Agents exits beta / research-preview status
- Pricing is published and falls within ~1.2× raw Messages API spend
- Approval / governance hooks land (`always_ask` is not enough; we need
  programmable risk evaluation, audit emission, and mobile relay)
- Multi-provider routing is supported (or we accept Anthropic-only
  orchestration as a tradeoff)

Realistic re-spike window: Q3 2026.

## Why now is wrong

The core insight from the dogfood loop (#531, #535–#538): **the platform
moat is governance scaffolding for weaker models**, not raw agent loop
execution. Anthropic owning the loop saves us code we already wrote and
already trust. It does not save us the things that differentiate o8.

Adopting Managed Agents in beta would also force a one-way migration
just as the loop is stabilizing — every dogfood session adds confidence
to the existing plumbing. Don't trade a known-working substrate for a
hosted unknown to chase a moat that isn't there.

## Migration path (if we ever do this)

If we revisit and decide to adopt:

1. Run side-by-side for 4–6 weeks. New orchestrator chats route to
   Managed Agents; existing lanes finish on the local loop.
2. Mirror approval emissions from `always_ask` into our `approvals`
   table so the audit ledger stays canonical.
3. Keep `cortex-mcp-server.ts` + `operator-mcp-server.ts` exposed as
   tools to Managed Agents — we own the governance surface, Anthropic
   owns the loop.
4. Retire `src/lib/lane/*` only after a full month with zero coordinator
   regressions.

## Decision: SKIP

Re-spike Q3 2026 or when Anthropic ships governance primitives that
match our approval surface. Until then, the custom loop is the moat.
