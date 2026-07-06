# o8 CLI

Agent-first wrapper over the local o8 HTTP API. Worker agents in dispatched
worktrees, CI runners, and scripts call `o8 <cmd>` instead of curling
`http://127.0.0.1:<port>/api/...` with a bearer token.

JSON to stdout is the default; pass `--human` for ANSI-formatted output.

## Phase 1 commands

| Command | Purpose |
|---|---|
| `o8 version` | CLI version + connected server version |
| `o8 doctor` | Verify port + token resolution; ping `/api/panel/status` |
| `o8 status` | Snapshot: running packets, active lanes, recent merges, pending approvals |
| `o8 packet info` | Info about the packet bound to the current worktree (auto-discovered via cwd) |
| `o8 packet stop <id>` | Interrupt the worker and hold the packet; resume with `packet reset` or `packet rerun`; `packet cancel` is an alias |
| `o8 mission stop --mission <id>` | Interrupt and hold every packet in a mission, then print per-packet results |
| `o8 run stop <runId>` | Stop an o8-managed run listed by `o8 run --list` |
| `o8 packet log <event>` | (Phase-1 stub) — will append a structured lane event once the backend route lands |

## Configuration

The CLI auto-discovers the running o8 backend.

Resolution order:

1. `O8_API_PORT` / `O8_API_TOKEN` env vars (set by dispatch for worker agents)
2. `~/.o8/api-port` and `~/.o8/ws-token`
3. `~/.cortex-ide/api-port` and `~/.cortex-ide/ws-token` (legacy data dir)
4. Fallback port `3001`, no token (dev workflow on loopback)

Loopback callers don't need a token; cross-origin callers do.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | invalid args / unexpected |
| 2 | connection refused (o8 not running) |
| 3 | unauthorized (bad token) |
| 4 | not found |
| 5 | conflict (state machine rejected the op) |

## Output schema

Every JSON payload includes a `schema` field:

```json
{ "schema": "o8/cli/<command>/v1", "...": "..." }
```

Errors:

```json
{
  "schema": "o8/cli/error/v1",
  "error": { "code": "...", "message": "...", "hint": "..." }
}
```

## Build

```sh
# from the repo root
npm run build:cli
# or from cli/
node esbuild.config.mjs
```

Produces `cli/dist/o8.mjs` — a single Node 22+ ESM bundle. Run directly via
`node cli/dist/o8.mjs <cmd>` or after a `chmod +x` as `./cli/dist/o8.mjs`.

## Typecheck

```sh
npx tsc --noEmit -p cli/tsconfig.json
```

## See also

- Epic [#926](https://github.com/hurttlocker/o8/issues/926) — full
  command surface and design principles.
