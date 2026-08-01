<p align="center">
  <img src="./assets/o8-icon.png" alt="" width="104">
</p>

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

## Your data

o8 runs on your machine, against your own subscriptions and keys. Your agents talk to whichever providers you configure — o8 itself is not in that path and adds no relay of its own.

Nothing is reported back to us unless you switch it on. Product telemetry, crash reports, and error transmission are each **off by default and opt-in**; crashes are captured to a local file so *you* can read them, and stay there until you decide otherwise. A packaged build carrying a Sentry DSN still transmits nothing until the toggle is on.

[`SECURITY.md`](./SECURITY.md) documents the rest plainly — including how dispatched workers run on your machine, and what OS-level sandboxing does and does not do today.

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

*The canvas — a spatial view of the same fleet. Two agents done and waiting at the gate, one still working, and a browser card previewing the page they just built.*

Merges that fail don't silently die — a five-layer escalation chain (auto-retry → orchestrator escalation → steer the warm session → fresh redispatch → human card) means a lane always has a defined next step. Approvals can route to your phone. The whole loop is drivable three ways: **the app**, **the `o8` CLI**, or **MCP tools** from any MCP client — same verbs, same gates.

## Symon — the voice layer

**Why a voice agent is in a control plane:** a fleet generates decisions while you're doing something else. Agents finish, reviews queue, a merge blocks — and the cost of that isn't the decision, it's having to stop, find the window, and reload the context. Symon closes that gap. You ask "what needs me?" without turning around, and approve the one thing that's blocking, hands still on whatever you were doing.

He runs on the rest of your Mac too, because an operator's day isn't only the fleet:

- **Fleet by voice** — status, what's blocked, what shipped. Approvals ride a *spoken confirm card*: he says what he's about to do and waits, so voice never becomes a way to skip governance.
- **Push-to-talk dictation** anywhere on the machine, with a local polish pass that fixes the transcript without shipping your words to a server.
- **Terminal watching** — "tell me when that finishes" — plus reading what's on screen when you ask about it.
- **The ordinary Mac** — calendar, reminders, mail, music, files, browser. Same confirm-card discipline for anything with a side effect.

Free tier uses on-device Apple transcription or your own Whisper key. An optional managed voice service (hosted polish, speech-to-speech) is the paid convenience — the app never requires it, and voice is never the only way to do anything.

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

![The o8 iOS app, two screens side by side: a morning catch-up showing 34 new commits across three tracked repositories, and a voice session where Symon answers with a generated status view and a checklist of what needs attention](./assets/phone.jpg)

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

## Contributing

Looking for a way in? Start with the [help-wanted issues](https://github.com/hurttlocker/o8/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22) — each one carries the diagnosis, the files involved, and what "done" looks like, so you're not reverse-engineering intent:

- **A worker sandbox profile that could be the default** ([#1657](https://github.com/hurttlocker/o8/issues/1657)) — the evidence map of what a real worker touches is already written.
- **Local models as a first-class profile** ([#1451](https://github.com/hurttlocker/o8/issues/1451)) — dispatch prefixes and a Brain tier exist; the coverage map and a verifiable no-egress test don't.
- **A repeatable per-release benchmark suite** ([#1158](https://github.com/hurttlocker/o8/issues/1158)) — four measurement scripts already run; they need a versioned scorecard.
- **The wrapper thesis on SWE-bench** ([#1159](https://github.com/hurttlocker/o8/issues/1159)) — an honest negative result is publishable, and we'll link it.
- **A canvas glass bug with a finished diagnosis** ([#1662](https://github.com/hurttlocker/o8/issues/1662)) — contained enough to land in an evening.

New runtimes are welcome too: adding one is a small documented patch ([`docs/internals/runtime-adapter-contract.md`](./docs/internals/runtime-adapter-contract.md)).

Community: [Discord](https://discord.gg/gH3UbbTJ7k) · Built in public by [@marquisehurtt](https://x.com/marquisehurtt)

## Third-party code

o8 builds on open-source libraries and adapted works. See [`NOTICE.md`](./NOTICE.md) for their authors, upstream sources, and license terms.

## License

MIT © Rainwater. The o8 name and logo are trademarks of Rainwater.
