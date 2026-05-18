# openclaw orchestrator — mobile integration contract

**Status:** v1 contract, current as of 2026-05-18. This is the spec the
o8-mobile `/openclaw` surface builds against. The desktop/backend side (this
repo) implements everything below — typecheck-clean on `main`.

## What this is

o8 runs an *orchestrator* — an LLM that plans work and dispatches Codex
worker agents into governed git-worktree packets. The orchestrator backend is
pluggable: **Codex** (default), **Claude**, and now **openclaw**.

openclaw is a *coexisting surface*, not a replacement. The default mobile
Orchestrator tab keeps talking to the default backend (Codex); a separate
mobile `/openclaw` screen talks to the openclaw backend. **Both run live at
the same time** — same WS channel, same chat component, different `backend`.

There is **no global toggle** that swaps the orchestrator. Backend selection
is per request: every WS message and the threads HTTP route carry an optional
`backend` field. Omit it → the default backend; pass `'openclaw'` → openclaw.

Throughout this doc, **`Backend`** = `'codex' | 'claude' | 'openclaw'`.

## 1. WebSocket — the `orchestrator` channel

All orchestrator traffic stays on the single `orchestrator` WS channel. The
mobile client adds an optional `backend` field to the messages it already
sends; the server tags every event it streams back with `backend`, so a
client subscribed to two surfaces renders each on the right one. `backend`
omitted → the server's global default (currently Codex).

### Client → server

| message | payload | notes |
|---|---|---|
| `orchestrator-subscribe` | `{ repoPath: string, backend?: Backend }` | Registers the client for this repo+backend. Server replies with a `status` event. |
| `orchestrator-send` | `{ repoPath: string, message: string, backend?: Backend, permissionMode?: 'full'\|'plan', thinkingEffort?: 'low'\|'medium'\|'high'\|'max'\|'xhigh', model?: string }` | Runs one orchestrator turn; streams events back. |
| `orchestrator-status` | `{ repoPath: string, backend?: Backend }` | One-shot; server replies with a `status` event. |
| `orchestrator-interrupt` | `{ repoPath: string, backend?: Backend }` | Aborts the in-flight turn for that repo+backend. |
| `orchestrator-unsubscribe` | `{ backend?: Backend }` | With `backend` → drops just that surface's subscription; without → drops all of this client's orchestrator subscriptions. |

### Server → client

Every event: `{ channel: 'orchestrator', event: <name>, data: {...} }`. Every
`data` carries `backend` — **filter inbound events on `data.backend`**.

| event | `data` | when |
|---|---|---|
| `status` | `{ status: 'ready'\|'busy'\|'dead', repoPath, backend, sessionName?: string }` | On subscribe, on status, and at turn start (`busy`) / end (`ready`). `sessionName` is present on the subscribe + status replies. |
| `output` | `{ text: string, repoPath, thinking: boolean, backend }` | Assistant text (`thinking:false`) or reasoning (`thinking:true`). |
| `tool-use` | `{ name: string, args: unknown, toolUseId: string\|null, repoPath, backend }` | The orchestrator called a tool. |
| `tool-result` | `{ name: string, args: unknown, output: string, toolUseId: string\|null, repoPath, backend }` | A tool returned. |
| `error` | `{ error: string, repoPath, backend }` | Turn failed. |
| `notice` | `{ repoPath, kind: 'mcp-reload', noticeId, message, registered }` | MCP-reload banner. Not `backend`-tagged. |

### Streaming — openclaw is non-streaming in v1

The Codex and Claude backends stream `output` / `tool-use` / `tool-result`
events live as the turn runs. **openclaw does not** — its CLI returns one
final result. An openclaw turn is exactly: `status: busy` → one `output` (the
full assistant text) → `status: ready`. No live deltas, no mid-turn tool
events. Build the openclaw chat for that shape — it is a documented v1
limitation, not a bug.

## 2. HTTP routes

### `GET /api/mobile/orchestrator/threads?backend=<Backend>`

Recent orchestrator threads. `?backend=openclaw` → only openclaw threads;
omitted or any other value → non-openclaw threads (the default surface;
untagged/legacy threads count as non-openclaw). The two surfaces never show
each other's threads.

Response: `{ threads: MobileOrchestratorThread[] }` — ≤ 20, newest first.
`MobileOrchestratorThread` (see `src/lib/mobile/types.ts`) now carries
`backend: 'codex' | 'claude' | 'openclaw' | null` (`null` = a legacy thread
persisted before tagging).

### `GET /api/mobile/orchestrator/packets?repoPath=<absolute path>`

**Unchanged.** Packets are repo-scoped and shared: whichever orchestrator
dispatched them, the workers are Codex packets in the one mission state for
that repo. There is no per-backend packet split — the openclaw surface and
the default tab show the *same* packets for a repo. Do not pass `backend`.

Response: `{ agents: MobileOrchestratorAgent[] }`.

### `GET /api/mobile/orchestrator/openclaw-availability`

Whether the openclaw backend is usable on this machine. The `/openclaw`
screen polls this to flip from a "coming online" placeholder to the live
surface.

Response: `{ available: boolean, reason?: string }`. `available` is true iff
`~/.openclaw/openclaw.json` exists AND has `mcp.servers.o8` registered. When
false, `reason` is a short user-facing string.

### `POST /api/v2/chat-history` — tagging openclaw threads

The write half of the threads `?backend=` filter. When the mobile `/openclaw`
surface persists an openclaw turn's transcript, it **must** include
`backend: 'openclaw'` in the POST body:

```
POST /api/v2/chat-history
{ tabId: 'thoughts-...', messages: [...], backend: 'openclaw',
  repoPath, repoName, repoBranch, model, ... }
```

The server stores `backend` in `~/.o8/chat-history/{tabId}.json`; the threads
route reads it for `?backend=`. `GET` returns `backend`; `PATCH` accepts it. A
thread persisted without `backend` is treated as non-openclaw.

*Decision:* the **client tags** on write. The server does not infer the
backend — chat-history persistence is client-driven, so the client, which
chose the backend, states it. Write path and read path agree on one field.

## 3. Auth / gating

- `/api/mobile/orchestrator/*` — including `openclaw-availability` — is
  **ungated** (absent from `GATED_PREFIXES` in `src/middleware.ts`), so
  LAN/Tailscale mobile clients reach it directly. No new gated routes were
  added — the `?backend=` approach reuses the existing routes.
- `/api/v2/chat-history` is **gated** (the `/api/v2/chat` prefix). The mobile
  app already sends `Authorization: Bearer <ws-token>` there; no change.

## 4. The `/openclaw` surface flow

1. Poll `GET /api/mobile/orchestrator/openclaw-availability`. While
   `available` is false, show "coming online" + `reason`.
2. When available — it is the existing orchestrator chat component, with:
   - `orchestrator-subscribe { repoPath, backend: 'openclaw' }`
   - `orchestrator-send { repoPath, message, backend: 'openclaw', ... }`
   - render inbound events where `data.backend === 'openclaw'`
   - threads list: `GET /api/mobile/orchestrator/threads?backend=openclaw`
   - packets pill: `GET /api/mobile/orchestrator/packets?repoPath=<path>`
   - persist transcript: `POST /api/v2/chat-history` with `backend: 'openclaw'`
3. `orchestrator-interrupt { repoPath, backend: 'openclaw' }` to stop a turn.

## 5. v1 scope vs end-state

**v1 (ships now):** the openclaw backend runs `openclaw --profile o8 agent
--local --json` against a generated, governed `o8` profile — a dedicated
`o8-orchestrator` agent with native worker-spawn (`sessions_spawn`) denied, so
its only dispatch path is the o8 operator MCP. Non-streaming, pi-harness
model.

**End-state (later, server-internal — invisible to mobile):** run via the
openclaw gateway so the operator's *own* existing openclaw agents are usable
as the orchestrator, with agent selection. None of that changes this contract
— the mobile surface talks to "the openclaw backend" regardless of how it
runs internally.
