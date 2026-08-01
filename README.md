# o8

[![CI](https://github.com/hurttlocker/o8/actions/workflows/ci.yml/badge.svg)](https://github.com/hurttlocker/o8/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE) [![Release](https://img.shields.io/github/v/release/hurttlocker/o8)](https://github.com/hurttlocker/o8/releases) [![Discord](https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white)](https://discord.gg/gH3UbbTJ7k)

o8 is an open-source desktop control plane for AI coding agents.

[Download the latest signed macOS build](https://github.com/hurttlocker/o8/releases) · [Build from source](#quickstart)

![o8 running a fleet of coding agents: three agents at work in isolated worktrees on the left, the governance queue holding incidents that need an operator decision on the right](./assets/hero.jpg)

**Run a fleet of coding agents. Approve what ships.**

Any agent CLI you already pay for — Claude Code, Codex, Gemini, Aider, Goose, and eight more — can do real engineering work in isolated git worktrees, and nothing merges without your approval.

The labs each ship their own agent and hope you live inside it. o8 is the neutral cockpit above all of them: one surface to dispatch, watch, review, and ship — with an audit trail for every decision. It runs on your machine, against your own subscriptions and keys. Free, MIT, complete.

> **If Cursor is an editor with an agent inside, o8 is the inverse: agents with a control room around them.**

---

## Why this exists

Coding agents got good. Managing them didn't. Run more than one and your day becomes five terminals, no shared memory, and `git log` as your only audit trail. Every vendor's answer is "use only ours."

o8's answer:

- **Any runtime, one contract.** 13 agent CLIs behind one adapter interface. Orchestrate with the model you trust, dispatch work to whichever is best (or cheapest) for the job. Swap vendors without changing how you work.
- **Governance is the product.** Every worker runs in an isolated worktree. Every diff gets reviewed — by you, or by an orchestrator model you've delegated to — before it touches your branch. Every approval, rejection, escalation, and merge is recorded.
- **Memory that compounds.** An organizational-memory layer (Cortex) turns session outcomes into durable directives, and an **Engineering Brain** answers questions about your repo and your fleet's history with citations — "what did the agents ship yesterday?" is a query, not an archaeology dig.
- **Operate from anywhere.** A paired iPhone app and mobile web surface: watch the fleet, steer a session, approve a merge from wherever you are.

## The runtimes

| Orchestrate or work | Workers (dispatchable) |
|---|---|
| Claude Code · Codex | Gemini CLI · opencode · Cursor CLI · Grok CLI · pi |
| | Aider · Goose · Kimi Code · OpenHands · Qwen Code · Qoder |

A first-run picker discovers what's installed and lets you choose your orchestrator + workers. No vendor pin — Codex is a default, not a requirement. Adding a runtime is a small, documented patch ([`docs/internals/runtime-adapter-contract.md`](./docs/internals/runtime-adapter-contract.md)) — community adapters welcome.

## How a mission runs

A mission is a goal. Each packet is a scoped unit of work, and each lane is the worker session that carries a packet through execution and review.

```
   you (or your orchestrator)
              │
        create mission ──▶ packets dispatched to workers
              │                 │  each in an isolated git worktree
              │                 ▼
              │            worker codes, reports, heartbeats
              │                 │
              ▼                 ▼
        review the diff ◀── work lands for review
              │
     approve ─┴─ reject / steer / rerun
              │
            merge  ──▶  audit trail, session ledger, memory
```

![Four agents on the canvas: two finished and waiting for review, one still working, and a live browser card previewing the page they built](./assets/fleet.gif)

Merges that fail don't silently die — a five-layer escalation chain (auto-retry → orchestrator escalation → steer the warm session → fresh redispatch → human card) means a lane always has a defined next step. Approvals can route to your phone. The whole loop is drivable three ways: **the app**, **the `o8` CLI**, or **MCP tools** from any MCP client — same verbs, same gates.

## Symon — the voice layer

o8 ships with a voice agent for the rest of your Mac: push-to-talk dictation, fleet status by voice ("what needs me?"), approve-by-voice behind spoken confirm cards, terminal watching ("tell me when that finishes"), calendar/reminders/mail. Free tier uses on-device Apple transcription or your own Whisper key. An optional managed voice service (hosted polish, speech-to-speech) is the paid convenience — the app never requires it.

## Quickstart

macOS today; Windows and Linux ports are mapped and in progress.

**Easiest:** download the latest signed build from [Releases](https://github.com/hurttlocker/o8/releases) — auto-updates included.

**From source** (Node 22+, Rust stable, Xcode CLT):

```bash
git clone https://github.com/hurttlocker/o8.git
cd o8
npm install
npm run dev             # Next.js :47120 + WS :47125
# native shell (starts its own coordinated dev stack):
npm run tauri:dev
```

Bring at least one agent CLI you already use (`claude`, `codex`, `gemini`, `aider`, …) — the first-run picker finds them. No API keys required to start; [`.env.example`](./.env.example) documents every optional one.

### Phone

<img src="./assets/phone.jpg" alt="The o8 iOS app: a morning catch-up screen showing 34 new commits ready to review across three tracked repositories, with a composer for asking the voice agent" width="300">

- **iOS app:** Pair by QR in seconds — beta access via [o8.run](https://o8.run).
- **Any phone:** the mobile web surface ships in this repo — pair any device on your network through the browser, no app needed.
- **Build your own:** the pairing protocol and WebSocket surface are open in this repo. Third-party clients are welcome.

### Connect Claude (or any MCP client)

Settings → MCP → Install. o8 exposes its operator tools — `create_mission`, `dispatch_mission`, `submit_review`, `approve_and_merge`, `cortex_ask`, plus webview controls that let an external Claude drive the running app — over MCP, so the same governance surface works from Claude Desktop, Claude Code, or anything else that speaks MCP.

## Free vs. paid, plainly

**Everything that runs on your machine is free and open source, forever.** The full app, all 13 runtimes, governance, memory, the Brain, the mobile surface, voice with your own keys. No feature gates, no seat limits.

Optional paid services (coming after launch) are the things that run on **our** servers: managed inference for the no-setup path, hosted voice, remote access without network config. Convenience, never capability. If you never pay, you have the whole product.

A capped **Founders Edition** — supporter badge, a numbered founding serial in the app, permanent founder pricing on future services — is available at launch via [o8.run](https://o8.run).

## Design

o8 is built like every pixel matters, because you stare at a control room all day: native macOS vibrancy glass, a two-axis theme system (light/dark × glass/solid), density with restraint, sustained-legibility typography. The locked spec lives in [`DESIGN.md`](./DESIGN.md) and [`hurttlocker.md`](./hurttlocker.md); read them before styling anything.

## More

- **Documentation:** [`docs/README.md`](./docs/README.md) — user guides, engineering internals, and operating runbooks.
- [`AGENTS.md`](./AGENTS.md) — the `o8` CLI reference (the same control plane, headless).
- [`CLAUDE.md`](./CLAUDE.md) — the canonical agent/contributor brief: architecture, conventions, critical rules.

Community: [Discord](https://discord.gg/gH3UbbTJ7k) · Built in public by [@marquisehurtt](https://x.com/marquisehurtt)

## Third-party code

o8 builds on open-source libraries and adapted works. See [`NOTICE.md`](./NOTICE.md) for their authors, upstream sources, and license terms.

## License

MIT © Rainwater. The o8 name and logo are trademarks of Rainwater.
