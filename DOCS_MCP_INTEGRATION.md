# DOCS MCP INTEGRATION — wire the o8 app to the public o8-docs MCP (as a CLIENT)

**Status:** brief for the app agent · 2026-06-25 · from the o8-site side
**One-liner:** the o8 desktop app should **connect to the public `o8-docs` MCP as a client**, so the in-app orchestrator (and dispatched agents) can answer *"how does o8 feature X work?"* from canonical, always-fresh product docs — cited.

---

## WHAT WE'RE LOOKING FOR

When a user (or their agent) asks o8 about **o8 itself** — "how do I set up dictation?", "what's the difference between a packet and a lane?", "how does review decide what to merge?" — the orchestrator should answer from the **canonical public documentation**, not from guesswork or stale training data. The docs already exist and are queryable over MCP. The app just needs to **consume** that MCP.

This is the "give their agent a documentation MCP to tell them all about o8" piece — built and live on the website. Now make the app a client of it.

## THIS IS NOT A MERGE — IT'S A CLIENT RELATIONSHIP

There are two different MCP servers. **Do not merge them.** They have opposite trust boundaries:

| | **operator MCP** (this app's, today) | **o8-docs MCP** (the website's) |
|---|---|---|
| Lives | bundled in the app, **local** | on o8.run, **public/remote** |
| Transport | stdio / loopback — localhost only | HTTP (streamable) on the internet |
| Power | dispatch, merge, approve, your repos, your Brain | **read-only public docs** |
| Audience | your machine's fleet | anyone's agent |

The operator MCP must stay local (it can merge code on the machine). The docs MCP is public + read-only (it can't touch anything). **The app becomes a CLIENT of the docs MCP** — it does not absorb it, and the docs MCP does not gain any of the app's powers.

Think of it next to `cortex_ask`:
- **`cortex_ask` (Brain)** → answers about the **user's own codebase** (their facts, their PRs, their decisions).
- **o8-docs MCP** → answers about **o8 the product** (how features work, concepts, setup).

Both should be available to the orchestrator. They're complementary, not competing.

## THE CONTRACT (what to connect to)

- **Endpoint:** `https://o8.run/mcp` — Model Context Protocol, **streamable HTTP**, read-only, no auth.
- **Server name:** `o8-docs` (v1.0.0).
- **Tools:**
  - `search_docs(query: string, section?: string)` → ranked pages with title, section, stability, summary, and canonical + `.md` URLs.
  - `fetch_page(slug: string)` → the full markdown of one page (e.g. `getting-started`, `review-and-approval`).
  - `list_sections()` → the whole doc tree (sections → pages + slugs).
- Lower-tech fallbacks if MCP is inconvenient anywhere: `https://o8.run/llms.txt` (curated map), `https://o8.run/llms-full.txt` (full corpus), and a `.md` twin of every page at `https://o8.run/docs/<slug>.md`. Same source as the MCP.

## WHERE TO WIRE IT (suggestions — you know the app)

- Register `https://o8.run/mcp` as a **default remote MCP server** available to the orchestrator's harness session (the Claude/Codex session the orchestrator runs through), so its tools are in-context when the user asks an o8 question. This is the cleanest path — the orchestrator just *has* `search_docs`/`fetch_page`.
- Optionally surface it on the **Canvas Brain card / "Ask o8"** affordance: route product/how-to questions to the docs MCP and codebase questions to `cortex_ask` (or let the model pick — both tools present).
- Cache responses locally (docs change on release cadence, not per-second). A short TTL is plenty.

## GUARDRAILS

- **Read-only + public** — nothing to authenticate, nothing it can mutate. Safe to expose to any orchestrator session.
- **Keep it out of the local operator MCP server.** Different server, different file, different trust boundary. The app is purely a *client* here.
- **Network-optional** — if o8.run is unreachable, degrade gracefully (fall back to `cortex_ask` / the model's own knowledge); never block a session on the docs MCP.
- The docs are leak-safe by construction (mechanism/governance altitude — no model IDs, routing, caps, or account IDs), so anything the orchestrator quotes from them is safe to show a user.

## DONE WHEN

A user asks the in-app orchestrator *"how do I set up dictation in o8?"* (or any product how-to), and it answers from the docs MCP — accurate and **citing the o8.run page** — without the user leaving the app. Codebase questions still go to the Brain; the two coexist.

---

*Built + owned on the o8-site side (the MCP, the docs, the freshness automation). Ping the o8-site agent if the contract needs to change. — from o8-site*
