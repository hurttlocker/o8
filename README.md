<p align="center">
  <img src="./assets/o8-icon.png" alt="" width="104">
</p>

# o8

[![CI](https://github.com/hurttlocker/o8/actions/workflows/ci.yml/badge.svg)](https://github.com/hurttlocker/o8/actions/workflows/ci.yml) [![Release](https://img.shields.io/github/v/release/hurttlocker/o8)](https://github.com/hurttlocker/o8/releases) [![Benchmark](https://img.shields.io/badge/benchmark-published%20with%20losses-8A5CF6)](./docs/user/honest-benchmark-2026-08.md)

**Run a fleet of coding agents. Approve what ships.**

o8 is an open-source control room for AI coding agents, the governance layer above them. Claude Code, Codex, Grok Build, DeepSeek Harness, OpenCode, Gemini, and twelve more do the work in isolated git worktrees, and nothing merges without you.

[**Download for macOS**](https://github.com/hurttlocker/o8/releases) · [Build from source](#get-it)

macOS today. Linux is one proof away from a build and Windows is help wanted; both are on the [roadmap](./ROADMAP.md).

![Four agents on the canvas: two finished and waiting for review, one still working, and a live browser card previewing the page they built](./assets/fleet.gif)

## What happens when you dispatch

1. You, or the orchestrator model you chose, create a mission. It becomes packets.
2. Each packet runs on the runtime you picked, in its own git worktree, and reports as it goes.
3. The work lands for review: the diff, the receipts, the cost.
4. You approve, reject, steer, or rerun. You can delegate the review to an orchestrator and keep the merge.
5. The merge writes the audit trail and the memory the next packet reads.

A merge that fails climbs a five-step ladder that ends at a human card, so no lane stalls silently. The same verbs work from the app, the `o8` CLI, any MCP client, your phone, and your voice. The long version is [How o8 works](./docs/user/how-o8-works.md).

## Runtimes

| Orchestrate or work | Workers (dispatchable) |
|---|---|
| Claude Code · Codex · OpenCode 2 | Gemini · Cursor · Grok Build · Pi · GitHub Copilot CLI · Crush |
| | Aider · Goose · Kimi Code · OpenHands · Qwen Code · Qoder |
| | 3code · Prime Agent · DeepSeek Harness |

Eighteen runtimes, one adapter contract, and a test that keeps this table equal to the registry. A first-run picker finds what is installed. Adding a runtime is a small documented patch: [runtime adapter contract](./docs/internals/runtime-adapter-contract.md). Claude Code can also keep its tools and session behavior while another model supplies inference: [model carriers](./docs/user/claude-code-model-carriers.md).

## Get it

**Easiest:** the latest signed build from [Releases](https://github.com/hurttlocker/o8/releases). It auto-updates.

**From source** needs Node 22.x (native modules are built against the Node 22 ABI), Rust stable, and Xcode Command Line Tools.

```bash
git clone https://github.com/hurttlocker/o8.git
cd o8
nvm install && nvm use   # .nvmrc pins Node 22
npm install
npm run dev              # web loop: Next.js :47120 + WS :47125
```

`npm run tauri:dev` builds the native shell (a much longer first build). After a hard kill, `node scripts/dev.mjs cleanup` recovers the ports. Bring at least one agent CLI you already use (`claude`, `codex`, `grok`, `opencode`, `gemini`); no API keys are needed to start, and [`.env.example`](./.env.example) documents every optional one.

- **Phone:** pair by QR. The iOS app is in beta via [o8.run](https://o8.run); the mobile web surface ships in this repo and works from any phone on your network.
- **Headless:** `o8 serve` runs the control plane on a machine with no screen, same gates. Pair a phone or attach the desktop later.
- **MCP:** Settings → MCP → Install exposes the operator tools (`create_mission`, `submit_review`, `approve_and_merge`, `cortex_ask`, and the webview controls) to Claude Desktop, Claude Code, or any MCP client.

## Your data

o8 runs on your machine against your own subscriptions and keys; it is not in the path between your agents and their providers. Telemetry, crash reports, and error transmission are off by default and opt-in. [`SECURITY.md`](./SECURITY.md) covers what dispatched workers can reach and what the sandbox does and does not do today.

## Free and paid

Everything that runs on your machine is free and open source: the app, all eighteen runtimes, governance, memory, the Brain, mobile, and voice with your own keys. Paid services, when they exist, are the things that run on our servers: managed inference, hosted voice, remote access without network setup. Convenience, never capability. A capped Founders Edition is at [o8.run](https://o8.run).

## Voice

Symon is the voice layer. Ask "what needs me?" without turning around, approve the one thing that is blocking, and dictate anywhere on the Mac. Anything with a side effect goes through a spoken confirm card, so voice never becomes a way around governance. Controls, setup, and tiers: [Voice](./docs/user/voice.md).

## Where it is going

[ROADMAP.md](./ROADMAP.md): seven pillars, what is open, what is missing on each, and what to claim.

## Contributing

Start with [CONTRIBUTING.md](./CONTRIBUTING.md) and the issues labeled [`claimable`](https://github.com/hurttlocker/o8/issues?q=is%3Aissue+is%3Aopen+label%3Aclaimable) or [`help wanted`](https://github.com/hurttlocker/o8/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22). UI changes read [`docs/design`](./docs/design/DESIGN.md) first. The full documentation index is [`docs/README.md`](./docs/README.md); the `o8` CLI reference is [`AGENTS.md`](./AGENTS.md).

Community: [Discord](https://o8.run/discord) · Built in public by [@marquisehurtt](https://x.com/marquisehurtt)

## License

MIT © Rainwater. The o8 name and logo are trademarks of Rainwater. Third-party code and adapted works are credited in [`NOTICE.md`](./NOTICE.md).
