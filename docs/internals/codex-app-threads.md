# Codex orchestrator chats in the Codex app

Setting: **Settings > Models > Codex app > Show chats in the Codex app** (`codexAppThreads`, `[orchestrator] codex_app_threads` in `settings.toml`). Off by default. Issue #3573.

## Why the chats are hidden by default

The Codex orchestrator normally runs each turn as `codex exec` with a private `CODEX_HOME` under the o8 data directory (`prepareCodexHome()`). That home carries o8's MCP servers and a pinned model, and it strips the operator's own MCP servers and plugins. Its threads are written there and are recorded with the `exec` source.

The Codex app lists threads from the operator's own Codex home (`~/.codex`). A `thread/list` request without `sourceKinds` returns only interactive sources (`vscode`, `cli`), so an `exec` thread would stay hidden even in that home.

## What the setting changes

With the setting on, a Codex orchestrator turn in Multitask or Fusion mode runs through the app-server bridge (`src/lib/codex/app-server-exec-bridge.ts`) instead of `codex exec`:

1. The session writes a private spec file (mode 0600) and starts the bridge with `CODEX_HOME` set to the operator's Codex home. The bridge deletes the spec when it reads it.
2. The bridge starts `codex app-server`, then calls `thread/start`, or `thread/resume` when the chat already has a Codex thread, and then `turn/start`. App-server records a new thread with the `vscode` source, so the Codex app lists it.
3. o8's orchestrator prompt is sent as `developerInstructions`. The turn input is only the operator's message, so the Codex transcript reads like a normal chat.
4. The bridge prints the same JSON lines as `codex exec --json`. The session parses, records, recovers and stops the turn on the same code path as exec.

Per-thread `config` overrides keep the turn equal to the private home:

- `mcp_servers`: o8's servers, plus `{ enabled: false }` for each server in the operator's `config.toml`.
- `plugins`: `{ enabled: false }` for each configured plugin.
- `tools.image_generation`: `false`.

Codex merges these overrides into `config.toml` instead of replacing tables, which is why the operator's entries are switched off by name. The overrides are one nested object: a mix of dotted keys and a table override is applied in no fixed order. The operator's `config.toml` is never written.

The model, reasoning effort and service tier go on the thread and turn requests. Access mode maps to the sandbox: Full access is `danger-full-access`, and Plan only is `read-only`. Approvals are `never` in both modes, and the bridge declines any approval request that still arrives.

## Limits

- Solo stays on the private home. It runs the whole Codex process in o8's sandbox with its own Codex home and blocked credentials.
- Local models (`ollama:`, `lmstudio:`) stay on `codex exec --oss`.
- Switching the setting starts a new Codex thread for an existing chat. The saved thread belongs to the other home, so resume reports a missing rollout and the session starts fresh.
- A turn the operator continues in the Codex app uses the operator's own Codex settings, not o8's tools. o8 sees those turns as thread history on its next turn.

## Turns added in the Codex app

The o8 chat also shows turns the operator adds from the Codex app, on desktop or phone (`src/lib/codex/app-thread-sync.ts`).

1. After `turn/start`, the bridge prints a `turn.started` line with the thread and turn ids. The session records each turn o8 runs in `<data dir>/codex-app-sync/<chat id>.json`. That file is separate from chat history, so a history save cannot drop it.
2. Every 4 seconds while the setting is on, the ws-server checks each recorded chat. It skips a chat while o8 is running a turn for it. It stats the thread's rollout file, whose path comes once from `thread/read`. When the file changed, it calls `thread/turns/list` (newest first, summary items) until it reaches a recorded turn.
3. Each completed turn that o8 did not run is appended to the o8 chat as the operator's message and the agent's final reply, with ids `codex-app-user-<turn>` and `codex-app-assistant-<turn>`. The turn is then recorded. A turn still in progress waits for the next pass.
4. The ws-server broadcasts `orchestrator-threads` / `external-turns` for that chat. An open chat reloads from history unless a turn is streaming in it.

Tool calls made in the Codex app are not copied; the o8 chat shows the message and the final reply.
