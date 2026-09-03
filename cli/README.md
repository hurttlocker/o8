# o8 CLI

Agent-first wrapper over the local o8 HTTP API. Worker agents in dispatched
worktrees, CI runners, and scripts call `o8 <cmd>` instead of curling
`http://127.0.0.1:<port>/api/...` with a bearer token.

JSON to stdout is the default; pass `--human` for ANSI-formatted output.

## Commands

| Command | Purpose |
|---|---|
| `o8 version` | CLI version + connected server version |
| `o8 doctor` | Verify port + token resolution; ping `/api/panel/status` |
| `o8 status` | Snapshot: running packets, active lanes, recent merges, pending approvals |
| `o8 history <thoughts-thread-id> [--limit 200]` | Read one continuous orchestrator transcript with permanent, audited handoff seams |
| `o8 worker spawn --title "..." [--repo <path>]` | Create and dispatch one governed worker from any local repo without adding it to Projects; the running app opens a dedicated worker pane |
| `o8 mission create --title "..." [--dispatch]` | Create a transient-repo mission; `--dispatch` starts it immediately |
| `o8 repo list` | List every repository registered in the running app |
| `o8 repo add <path>` | Register an existing local Git repository from any current directory |
| `o8 repo remove <id\|name\|path>` | Remove the registration and project links while preserving the local folder and remote |
| `o8 project list` | List projects, active state, and repo membership |
| `o8 project create <name> [--repo <target>...]` | Create a project and optionally attach registered repos |
| `o8 project use <target>` | Switch the active project by ID or exact name |
| `o8 project add-repo <project> <repo>` | Attach a registered repo without changing its folder |
| `o8 project remove-repo <project> <repo>` | Detach a repo while preserving its registration and folder |
| `o8 project delete <target>` | Delete a project and its exclusive repo registrations while preserving every local folder and remote |
| `o8 packet info` | Info about the packet bound to the current worktree (auto-discovered via cwd) |
| `o8 packet stop <id>` | Interrupt the worker and hold the packet; resume with `packet reset` or `packet rerun`; `packet cancel` is an alias |
| `o8 mission stop --mission <id>` | Interrupt and hold every packet in a mission, then print per-packet results |
| `o8 run stop <runId>` | Stop an o8-managed run listed by `o8 run --list` |
| `o8 run --last` | Show the latest run's command, start time, durable exit receipt, and retained log path |
| `o8 packet log <event>` | (Phase-1 stub) — will append a structured lane event once the backend route lands |

## Configuration

The CLI auto-discovers the running o8 backend.

Outside terminals and agents can dispatch from an unregistered repo. o8 keeps
the repo context on the mission and audit history, but it does not add the repo
to the user's saved Projects list. Pass `--caller <label>` when the app should
show which outside agent or terminal started the worker.

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
| 6 | server timeout; the operation may have landed |

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
