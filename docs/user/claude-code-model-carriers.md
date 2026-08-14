# Claude Code model carriers

o8 can use Claude Code as the tool and agent harness while choosing where the model comes from. The model source applies to new Claude Code orchestrator chats and workers; a running session keeps the source and model it started with.

Open **Settings → Models → Claude Code harness** to choose one of these sources:

| Source | Authentication | Usage boundary | When to use it |
|---|---|---|---|
| **Native account** | The login or enterprise gateway already configured in Claude Code | The configured Claude account or gateway | Use the standard Claude Code model and billing path. |
| **OpenRouter** | The encrypted OpenRouter key stored in o8 | Metered API usage | Use another tool-capable model through the Claude Code harness. |
| **Codex subscription** | A one-time browser OAuth flow through a local carrier | The connected Codex subscription quota | Use a Codex model with Claude Code's tools and session behavior without an API key. |

## Connect a Codex subscription

The Codex subscription carrier is experimental and is not an official interoperability path from either CLI vendor. It depends on the installed Claude Code CLI and the installed local carrier, so an upstream protocol or account-policy change can temporarily break this path without affecting native Claude Code or direct Codex workers. Review the terms that apply to both installed CLIs and the connected account before enabling it.

1. Install Claude Code and confirm that `claude --version` works.
2. Install the local carrier with `brew install cliproxyapi`.
3. Open **Settings → Models → Claude Code harness**.
4. Select **Codex subscription** as the model source.
5. Click **Connect Codex**, then complete the browser authorization.
6. Select a model reported by the connected subscription.
7. Start a new orchestrator chat or Claude Code worker.

o8 binds the carrier to `127.0.0.1`, disables remote management, generates a local client token, and stores the carrier configuration and OAuth files with owner-only permissions. o8 does not send those credentials through its own relay.

If the connection stops working, confirm that `cliproxyapi` is still installed, then open the same settings section and reconnect. Native account and OpenRouter remain independent fallback sources.

## Sessions and prompt caching

Each orchestrator chat gets its own resident Claude Code process, Claude session, and carrier configuration. Two chats do not share conversation history, even when they use the same repository and model source.

The first turn in a new chat is expected to be cold because Claude Code loads the repository instructions, tools, and system context. Later turns reuse the same resident process and stable prompt prefix, so the provider can serve most of that prefix from its prompt cache. o8 keeps the full harness context available; it does not remove project instructions to reduce tokens.

The turn receipt reports one of these cache states when the runtime supplies the data:

- **Cold prompt** means the completed turn reported no cache-read tokens.
- **Prompt cached** is the share of fresh input, cache reads, and cache writes served from the read cache.
- No cache label means the runtime did not report enough cache data to calculate one.

A new chat has a separate cold start by design. This preserves isolation between orchestrators and prevents one chat's instructions or history from leaking into another.

## Cost and capacity

The Codex subscription source does not need an OpenAI API key. Its turns count against the connected Codex subscription quota. o8 reads the current Codex capacity from the local Codex app server when available and falls back to the local session record if the live read fails.

Token and cache counts describe model usage. They are not a cash charge. o8 does not present Claude Code's cumulative API-equivalent cost field as the cost of one subscription-backed turn because doing so would double-count the session and imply a charge that did not occur.

OpenRouter is different: those turns are API-billed to the configured OpenRouter account. Native account usage follows whatever account or gateway Claude Code is already using.

## Maintainer verification

The deterministic tests do not spend provider quota. Before a release that changes this path, a maintainer can run the opt-in live proof:

```bash
O8_LIVE_CLAUDE_CODE_CODEX_ORCHESTRATOR=1 \
  npx vitest run tests/claude-code-codex-orchestrator-live-smoke.test.ts
```

The live test proves that a real Claude Code process can use the Codex subscription carrier, read project instructions on the first turn, reuse the same process and Claude session on a warm follow-up, report more than 90% cache-read prompt tokens on that follow-up, and keep a second orchestrator chat isolated in a different process and configuration directory.

Run this test deliberately. It uses the connected Codex subscription quota and requires a working Claude Code installation, local carrier, and completed OAuth connection.
