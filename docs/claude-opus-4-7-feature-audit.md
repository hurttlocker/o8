# Claude Opus 4.7 Feature Audit for o8

Produced 2026-04-17 by a background research agent. Canonical reference for
the "wire the moat" epic. Priority order at the bottom — everything else is
context.

## Summary Table

| Feature | Status | Cost Impact | Moat | Priority |
|---------|--------|-------------|------|----------|
| Prompt Caching | GA | 3–4× savings on governance loops | CRITICAL | #1 wire now |
| Adaptive Thinking + Summarized Display | GA | No premium; full thinking still billed | HIGH | #2 after caching |
| Task Budgets | Beta | Advisory per-loop cap | MEDIUM | #3 per-phase |
| Managed Agents | Beta | Could offload agent loop | STRATEGIC | #4 arch spike |
| High-Res Vision (4.7) | GA | ~(w×h)/750 tokens per image | LOWER | #5 for debugging |
| MCP Native | GA | No changes needed | MEDIUM | monitor |
| Computer Use | Beta | Circular-control risk | LOWER | skip |
| Memory / Pinning | Partial | Part of Managed Agents | MEDIUM | re-eval with MA |
| Safety / Refusals | GA | No changes | LOWER | monitor |

---

## 1. Prompt Caching — CRITICAL

Breakpoints cache static content (system prompt, tool definitions). Subsequent
turns read from cache at 10% cost vs 25% write cost.

**o8 governance loop impact** — orchestrator → review → refix → merge is 4–5
Claude turns. System prompt + tools are identical across all of them.

Cost example:
- Turn 1: 100k tokens · cache write 1.25× = 125k billing units
- Turn 2: 100k new tokens · system+tools cache read 0.1× = 10.5k units
  (saves 104.5k)
- Turns 3–5: same pattern

**Total multi-turn savings: 40–50%.**

Wiring: one `cache_control: { type: 'ephemeral' }` on the system+tools block.
No architecture change.

## 2. Adaptive Thinking + Summarized Display — HIGH

`thinking: { type: 'adaptive' }` + `display: 'summarized'`:

- Claude thinks internally (full token billing)
- API returns a condensed summary, not 50k-token raw traces
- Thinking omitted by default for speed; opt in to see summaries

**o8 application:** surface partial reasoning in orchestrator chat. "Claude is
considering edge cases…" appears before the final response streams. Turns the
approval gate from a black-box wait into a visible reasoning surface — builds
operator trust.

No pricing premium. UI + UX win.

## 3. Task Budgets — MEDIUM (Beta)

Advisory token cap per agentic loop. Model sees countdown and self-regulates,
stops early with partial results rather than mid-sentence truncation.

**o8 application:** per-phase budgets.
- Synthesis: `task_budget: 100k`
- Review: `task_budget: 50k`
- Merge: `task_budget: 25k`

Pitfall: undersized budget triggers refusal. Size from real task distribution.

Pairs well with Opus 4.7's `xhigh` effort level for agentic work.

## 4. Managed Agents — STRATEGIC (Beta, research preview)

Anthropic-hosted agent harness. You define agents, environments, tools.
Anthropic handles:
- Agent loop execution
- Tool execution in sandbox
- File-system persistence per session
- **Built-in compaction** (automatic summarization at context limit)
- Multi-agent orchestration (coordinator calls specialized agents)

**o8 application:** the orchestrator becomes a coordinator Managed Agent.
Codex sessions become callable worker agents. o8 routes via Anthropic's
harness instead of our custom lane dispatch.

Key architectural questions:
- Does packet dispatch map to Managed Agents' callable-agent pattern?
- Does session-thread persistence replace our lanes logic?
- How does the approval gate integrate with Managed Agents' `always_ask`
  tool confirmation?

No pricing announced. Likely Messages API + infrastructure fee.

Treat as a 1-week architecture spike, not an implementation task.

## 5. High-Res Vision — LOWER

Claude 4.7 only: 2576px / 3.75MP (up from 1568px / 1.15MP). 1:1 coordinate
mapping, no scale math. Better low-level perception (pointing, bounding-box
localization).

~`(width × height) / 750` tokens per image.

**o8 application:** Codex error screenshots — Claude spots UI details during
worktree debugging. Not a bottleneck yet.

## 6. Everything else (no action)

| Feature | Why no action |
|---------|---------------|
| MCP Native | Already wired — operator + cortex servers. Re-evaluate with Managed Agents. |
| Computer Use (Beta) | Skip. Risk of circular control (Claude driving o8 itself). `o8_view_*` MCP tools are the safer equivalent. |
| Memory / Pinning | Keep Cortex v2 directives + session ledger. Re-evaluate if adopting Managed Agents. |
| Safety / Refusals | Anthropic's problem. Governance gate is our primary safety layer. |

---

## Top 5 Wiring Sequence

| # | Feature | Effort | ROI | When |
|---|---------|--------|-----|------|
| 1 | Prompt Caching (system + tools breakpoint) | LOW | 3–4× cost | Week 1–2 |
| 2 | Task Budgets (per-phase config) | LOW | Predictable spend | Week 2 |
| 3 | Adaptive Thinking + Summarized Display | MEDIUM | Visible reasoning → operator trust | Week 3–4 |
| 4 | Managed Agents evaluation | HIGH | Offload agent loop to Anthropic | Week 5–8 (spike) |
| 5 | High-Res Vision for debugging | MEDIUM | Better Codex screenshot analysis | Week 9+ |

---

## Takeaways

1. **Caching is table-stakes.** Governance loops are Claude-heavy; 3–4× cost
   reduction in week one pays for everything else.
2. **Visible thinking transforms UX.** Summarized thinking in orchestrator
   chat builds operator confidence in the approval gate. That is a moat.
3. **Task Budgets + Adaptive Thinking are a pair.** Together they give
   predictable, graceful cost control across dispatch phases.
4. **Managed Agents is architecture-level.** Worth a spike. Could eliminate
   custom agent loop plumbing and offload memory/compaction to Anthropic —
   but requires rethinking lanes, dispatch routing, and approval integration.
5. **Don't build what commoditizes.** Vision, computer use, safety refusals
   are table-stakes. Focus on governance, cost predictability, operator
   confidence — the moats.

---

## Sources

- https://www.anthropic.com/news/claude-opus-4-7
- https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-7
- https://platform.claude.com/docs/en/build-with-claude/extended-thinking
- https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- https://platform.claude.com/docs/en/build-with-claude/task-budgets
- https://platform.claude.com/docs/en/build-with-claude/effort
- https://platform.claude.com/docs/en/managed-agents/overview
- https://platform.claude.com/docs/en/managed-agents/multi-agent
- https://code.claude.com/docs/en/desktop
- https://platform.claude.com/docs/en/build-with-claude/vision
- https://platform.claude.com/docs/en/about-claude/models/overview
