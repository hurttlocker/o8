# o8 Monetization — Free / Pro tiers (DRAFT)

**Status:** draft for operator review · 2026-06-07 · **internal strategy** (not for the public/OSS repo).

## Principle — gate the moats, give away the commodity
Per our doctrine ("don't build what models will commoditize"), orchestration quality, cost dashboards, and prompt tools are **table stakes** → they go in **Free** to win adoption. The **moats** — governance, organizational memory, fleet, mobile/teams — are **Pro**.

> **The load-bearing rule: activation lives in Free, depth lives in Pro.**
> Free users must *feel* governance catch a real bug on first run, or the funnel leaks at the top. Pro is what they upgrade to once they trust o8 on real work.

---

## FREE — *"stretch your plan, locally, with a taste of governance"*
The wedge for the quota-burning + local-first crowd (r/LocalLLaMA, r/ClaudeAI, r/cursor).

| Capability | Why Free |
|---|---|
| Local-first desktop app · **BYO-key** (Claude / Codex / Gemini / OpenAI / OpenRouter) · data in `~/.o8` | The local-first trust pitch; acquisition |
| **Orchestrator** (Claude orchestrates) + **dispatch Codex** in isolated worktrees | The core loop = the "stretch your plan" hook |
| **Single repo / single workspace** · terminals · chat · tile workspace | Enough to be genuinely useful, not crippleware |
| **Single-pass review gate** | ← **the activation** — watch governance catch a bug before merge |
| Basic approvals inbox (approve / reject) · manual merge | Feel the operator surface |
| Cost / usage visibility | Table stakes (models commoditize this) |

## PRO — *"govern a fleet, with memory, on the go, as a team"*
Each bucket is one of the four moats.

| Bucket | What's gated |
|---|---|
| **Deep governance** | AI second-pass review + the AGREE-gate · approval policies · full audit trail · merge + pre-ship boot gate |
| **Organizational memory** | Cortex directives + session ledger + the **Engineering Brain** Q&A |
| **Fleet** | Multi-repo orchestration · parallel agent swarms · fleet view |
| **Mobile operator control** | Approve / dispatch / steer from your phone |
| **Teams** | Profiles · shared directives · cross-repo governance · team audit |

---

## Why this split holds
- Forking the Free core gives a competitor the **commodity loop, not the moats** (and the moats need the license server + ongoing dev). Nothing defensible is lost by open-sourcing the core.
- Free is real (drives adoption + GitHub stars), but the **depth** that makes o8 indispensable on real/team work is Pro.

## Open questions (operator)
- Exact gating line *within* governance — how much second-pass / audit shows in Free as the "taste"?
- Pricing — solo Pro $/mo · team $/seat.
- Trial — time-limited Pro trial vs. usage-limited.

## Plumbing (our defaults, once gating is locked)
Stripe billing + license key → Clerk profiles/auth → Railway entitlement server (Stripe webhook issues/revokes keys) → app validates key → flips Pro feature flags. Desktop licensing, not seat-based SaaS login.
