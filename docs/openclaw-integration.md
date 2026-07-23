# openclaw orchestrator — mobile integration contract

**Status:** current as of 2026-05-18. This is the spec the o8-mobile
`/openclaw` surface builds against.

- **v1 (single-agent) — LIVE**, shipped in o8 v0.1.149: the openclaw backend,
  per-request `backend` selection, the `orchestrator` WS channel, and the
  threads / availability / chat-history routes.
- **Multi-agent (openclaw step 5) — IN PROGRESS.** Everything tagged
  **[step 5]** below — the per-request `agent` field, the `openclaw-agents`
  route, per-agent thread tagging. The contract is frozen; the backend lands
  it now and the o8-mobile `/openclaw` surface builds against it in parallel.
  Until the backend ships, a `[step 5]` route 404s and an `agent` field is
  ignored — the same graceful-degrade the surface already does while
  `openclaw-availability` is unavailable.

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

**[step 5] The openclaw backend has a second per-request dimension — the
openclaw *agent*.** An openclaw profile holds one or more agents (the
operator's holds two — `main` and `main-public`, both display-named "Mister").
The mobile `/openclaw` surface is built **grouped by agent**, one group per
agent, and the operator picks the agent per chat. Agent selection mirrors
backend selection exactly: a global default for headless paths, plus a
per-request `agent` override on every WS message. `agent` only applies when
`backend: 'openclaw'`.

Throughout this doc, **`Backend`** = `'codex' | 'claude' | 'openclaw'`, and an
**openclaw agent id** is a string key from the openclaw profile (e.g. `main`).

## 1. WebSocket — the `orchestrator` channel

All orchestrator traffic stays on the single `orchestrator` WS channel. The
mobile client adds optional `backend` and `agent` fields to the messages it
already sends; the server tags every event it streams back, so a client
subscribed to two surfaces renders each on the right one. `backend` omitted →
the server's global default (currently Codex).

### Client → server

| message | payload | notes |
|---|---|---|
| `orchestrator-subscribe` | `{ repoPath: string, backend?: Backend, agent?: string }` | Registers the client for this repo + backend + agent. Server replies with a `status` event. |
| `orchestrator-send` | `{ repoPath: string, message: string, backend?: Backend, agent?: string, permissionMode?: 'full'\|'plan', thinkingEffort?: 'low'\|'medium'\|'high'\|'max'\|'xhigh', model?: string }` | Runs one orchestrator turn; streams events back. |
| `orchestrator-status` | `{ repoPath: string, backend?: Backend, agent?: string }` | One-shot; server replies with a `status` event. |
| `orchestrator-interrupt` | `{ repoPath: string, backend?: Backend, agent?: string }` | Aborts the in-flight turn for that repo + backend + agent. |
| `orchestrator-unsubscribe` | `{ backend?: Backend, agent?: string }` | With `backend` (+ optional `agent`) → drops just that surface's subscription; without → drops all of this client's orchestrator subscriptions. |

**[step 5] The `agent` field.** `agent` is the openclaw agent id; it is only
meaningful when `backend: 'openclaw'` and is ignored for every other backend.
The server keys sessions and subscriptions per **repo + backend + agent** — the
same repo subscribed with `agent: 'main'` and with `agent: 'main-public'` is
two independent orchestrator sessions, each with its own transcript and its
own in-flight turn. Omit `agent` → the backend's default openclaw agent (what
headless paths use); the mobile surface always sends it explicitly.

### Server → client

Every event: `{ channel: 'orchestrator', event: <name>, data: {...} }`. Every
`data` carries `backend`; **[step 5]** openclaw events also carry `agent` —
**filter inbound events on `data.backend`, and for openclaw on `data.agent`**.

| event | `data` | when |
|---|---|---|
| `status` | `{ status: 'ready'\|'busy'\|'dead', repoPath, backend, agent?, sessionName?: string }` | On subscribe, on status, and at turn start (`busy`) / end (`ready`). `sessionName` is present on the subscribe + status replies. |
| `output` | `{ text: string, repoPath, thinking: boolean, backend, agent? }` | Assistant text (`thinking:false`) or reasoning (`thinking:true`). |
| `tool-use` | `{ name: string, args: unknown, toolUseId: string\|null, repoPath, backend, agent? }` | The orchestrator called a tool. |
| `tool-result` | `{ name: string, args: unknown, output: string, toolUseId: string\|null, repoPath, backend, agent? }` | A tool returned. |
| `error` | `{ error: string, repoPath, backend, agent? }` | Turn failed. |
| `notice` | `{ repoPath, kind: 'mcp-reload', noticeId, message, registered }` | MCP-reload banner. Not `backend`/`agent`-tagged. |

`agent` is present on every openclaw event and absent for codex/claude events.

### Streaming — openclaw is non-streaming in v1

The Codex and Claude backends stream `output` / `tool-use` / `tool-result`
events live as the turn runs. **openclaw does not** — its CLI returns one
final result. An openclaw turn is exactly: `status: busy` → one `output` (the
full assistant text) → `status: ready`. No live deltas, no mid-turn tool
events. Build the openclaw chat for that shape — it is a documented
limitation, not a bug. (Unchanged by step 5 — multi-agent does not add
streaming.)

## 2. HTTP routes

### `GET /api/mobile/orchestrator/threads?backend=<Backend>`

Recent orchestrator threads. `?backend=openclaw` → only openclaw threads;
omitted or any other value → non-openclaw threads (the default surface;
untagged/legacy threads count as non-openclaw). The two surfaces never show
each other's threads.

Response: `{ threads: MobileOrchestratorThread[] }` — ≤ 20, newest first.
`MobileOrchestratorThread` (see `src/lib/mobile/types.ts`) carries
`backend: 'codex' | 'claude' | 'openclaw' | null` (`null` = a legacy thread
persisted before tagging) and **[step 5]** `agent: string | null` — the
openclaw agent id that ran the thread (`null` for non-openclaw or untagged
threads). The `/openclaw` surface groups the `?backend=openclaw` list by
`agent`.

### `GET /api/mobile/orchestrator/packets?repoPath=<absolute path>`

**Unchanged.** Packets are repo-scoped and shared: whichever orchestrator
dispatched them — any backend, any openclaw agent — the workers are Codex
packets in the one mission state for that repo. There is no per-backend or
per-agent packet split. Do not pass `backend` or `agent`.

Response: `{ agents: MobileOrchestratorAgent[] }`. (Here `agents` is the
legacy field name for dispatched *packets* — unrelated to openclaw agents.)

### `GET /api/mobile/orchestrator/openclaw-availability`

Whether the openclaw backend is usable on this machine. The `/openclaw`
screen polls this to flip from a "coming online" placeholder to the live
surface.

Response: `{ available: boolean, reason?: string }`. `available` is true iff
`~/.openclaw/openclaw.json` exists AND has `mcp.servers.o8` registered. When
false, `reason` is a short user-facing string.

### `GET /api/mobile/orchestrator/openclaw-agents` — [step 5]

The openclaw agents available on this machine — the `/openclaw` surface builds
its agent groups from this list.

Response: `{ agents: Array<{ id: string; name: string }> }`, read from
`~/.openclaw/openclaw.json` `agents.list`. `id` is the stable agent key (the
value passed back as the `agent` field everywhere else); `name` is the display
name and may collide across agents — always key on `id`. Returns
`{ agents: [] }` when the openclaw config is missing or unreadable. Ungated,
like the rest of `/api/mobile/orchestrator/*`.

### `POST /api/v2/chat-history` — tagging openclaw threads

The write half of the threads `?backend=` filter. When the mobile `/openclaw`
surface persists an openclaw turn's transcript, it **must** include
`backend: 'openclaw'` and **[step 5]** `agent` in the POST body:

```
POST /api/v2/chat-history
{ tabId: 'thoughts-...', messages: [...], backend: 'openclaw', agent: 'main',
  repoPath, repoName, repoBranch, model, ... }
```

The server stores `backend` and `agent` in `~/.o8/chat-history/{tabId}.json`;
the threads route reads them. `GET` returns both; `PATCH` accepts both. A
thread persisted without `backend` is treated as non-openclaw; without `agent`,
its `agent` is `null`.

*Decision:* the **client tags** on write — both `backend` and `agent`. The
server does not infer them: chat-history persistence is client-driven, so the
client, which chose the backend and agent, states them. Write path and read
path agree on the same two fields.

## 3. Auth / gating

- `/api/mobile/orchestrator/*` — including `openclaw-availability` and
  **[step 5]** `openclaw-agents` — is default-deny. Paired mobile clients reach
  only the methods and paths named in `DEVICE_CAPABILITIES` in
  `src/middleware.ts`.
- `/api/v2/chat-history` is also gated. The paired app sends its device bearer;
  desktop/operator clients send the operator ws-token.

## 4. The `/openclaw` surface flow

1. Poll `GET /api/mobile/orchestrator/openclaw-availability`. While
   `available` is false, show "coming online" + `reason`.
2. **[step 5]** `GET /api/mobile/orchestrator/openclaw-agents` → build one
   group per agent. The operator picks an agent → that is the active chat's
   `agent`.
3. Per chat — the active agent's `id` rides every message:
   - `orchestrator-subscribe { repoPath, backend: 'openclaw', agent }`
   - `orchestrator-send { repoPath, message, backend: 'openclaw', agent, ... }`
   - render inbound events where `data.backend === 'openclaw'` **and
     `data.agent` matches the active agent**
   - threads list: `GET /api/mobile/orchestrator/threads?backend=openclaw`,
     then group the result by each thread's `agent`
   - packets pill: `GET /api/mobile/orchestrator/packets?repoPath=<path>`
     (unchanged — repo-scoped, shared across agents)
   - persist transcript: `POST /api/v2/chat-history` with `backend: 'openclaw'`
     and `agent`
4. `orchestrator-interrupt { repoPath, backend: 'openclaw', agent }` stops that
   agent's turn.

## 5. Single-agent v1 → multi-agent (step 5)

**v1 (shipped, o8 v0.1.149):** the openclaw backend ran `openclaw --profile o8
agent --local --json` against a generated `o8` profile holding a single
synthetic `o8-orchestrator` agent — native worker-spawn (`sessions_spawn`)
denied so its only dispatch path is the o8 operator MCP. Non-streaming,
pi-harness model. A test scaffold: one agent, not the operator's own.

**Multi-agent (step 5, in progress):** the `o8` profile holds governed
**copies of the operator's real openclaw agents** (`main`, `main-public`) —
each copy keeps the agent's id / name / model / prompt / skills and only adds
`sessions_spawn` to `tools.deny`. The backend runs via the openclaw gateway
(not `--local`), so each agent runs on its real harness and model. The mobile
`/openclaw` surface picks which one per chat (section 4).

Unlike v1, **this layer is mobile-facing** — it is exactly the three contract
additions tagged `[step 5]` above: the `openclaw-agents` route, the per-request
`agent` WS field, and per-agent thread tagging. The gateway migration itself
(port allocation, dropping `--local`) stays server-internal — mobile only ever
sees "an openclaw agent", never how it is hosted.
