# Anthropic Third-Party Harness Ban: Impact on o8

**Date:** 2026-04-05
**Status:** No impact on o8 production

## What happened

On April 4, 2026, Anthropic severed third-party tool access to Claude subscription tokens. OAuth tokens from Pro/Max subscriptions no longer function outside Anthropic's own interfaces (Claude Code, Claude.ai, Claude Desktop). Third-party harnesses like OpenClaw must now use pay-as-you-go API billing. Source: [ccleaks.com/news/anthropic-kills-third-party-harnesses](https://ccleaks.com/news/anthropic-kills-third-party-harnesses)

## Why o8 is unaffected

### o8 is a control plane, not a harness

A harness intercepts or reroutes Claude subscription tokens through a non-Anthropic OAuth flow. o8 does neither. It is a governance layer that sits above runtimes — it doesn't replace them.

### Claude Code adapter calls the CLI directly

The Claude Code runtime adapter (`src/lib/runtimes/claude-code.ts`) shells out to the `claude` binary at `~/.local/bin/claude`. This is identical to a user typing `claude` in their terminal. The adapter:

- Discovers sessions from `~/.claude/projects/`
- Reads JSONL transcript files from disk
- Launches/resumes/interrupts via `claude` CLI flags (`-c`, `-n`, `-w`)

No subscription tokens are proxied, intercepted, or rerouted. o8 talks to Claude Code the same way any terminal does.

### Codex adapter is OpenAI

The second runtime adapter (`src/lib/runtimes/codex.ts`) uses the Codex CLI, which is an OpenAI product. Entirely outside Anthropic's scope.

### OpenClaw was already removed

OpenClaw — the third-party harness most directly targeted by this ban — was removed from o8's runtime code prior to this announcement. The only remnants were:

- One stale marketing string in the onboarding carousel (removed in #494)
- Two legacy shell scripts in `scripts/` (dead code, not called by the app)
- ~30 references in `docs/` and agent configs (historical documentation)

No production code path depended on OpenClaw.

### AI Router delegates to Gemini and Codex

The AI Router MCP (`~/.claude/mcp-servers/ai-router/`) delegates research tasks to Gemini CLI (Google, $20 subscription) with Codex (OpenAI) as fallback. No Anthropic subscription tokens are involved in delegation.

## What would affect us

If Anthropic were to restrict programmatic invocation of the `claude` CLI — i.e., making it so only interactive terminal sessions work — that would break o8's Claude Code adapter. This seems unlikely since:

1. Claude Code is designed for automation (it accepts `--json`, `--print`, piped input)
2. Anthropic actively promotes Claude Code in CI/CD and scripting contexts
3. The Claude Code SDK exists specifically for programmatic use

If this ever changed, o8's adapter interface (`AgentRuntime` in `src/lib/runtimes/types.ts`) abstracts the runtime layer. Switching to a different Claude integration (API direct, SDK, etc.) would be a single adapter swap, not an architectural change.

## The ban actually strengthens o8's position

Anthropic locking down how Claude can be used makes governance layers more valuable:

- **Users need sanctioned interfaces.** o8 works within them (Claude Code CLI), not around them.
- **Cost visibility matters more.** With harnesses gone, users on API billing need usage tracking and approval controls — exactly what o8 provides.
- **The "bring your own runtime" model wins.** o8 doesn't depend on any single provider's auth model. It governs whatever runtimes the user has installed.

## Residual cleanup

| Item | Status | PR |
|------|--------|----|
| OpenCode + Aider removed from CLI agent lists | Done | #494 |
| OpenClaw removed from onboarding copy | Done | #494 |
| Legacy `scripts/rest-api-patch.sh` and `rest-api-watchdog.sh` | Dead code, can delete when convenient | — |
| OpenClaw references in `docs/` | Historical context, no action needed | — |
