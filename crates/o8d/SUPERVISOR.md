# Opt-in process supervisor protocol v1 (#4488)

The Linux-only `o8d --experimental-supervisor --socket <path> --state-dir <dir>`
mode owns finite-input batch worker process groups independently of the app
server. It stays alive when stdin closes or an app connection disappears. It is
separate from the websocket and MCP modes. No launcher selects it by default.

## Transport and authentication

One UTF-8 JSON request and one JSON response per Unix-domain connection, each
terminated by LF. Requests are at most 2 MiB, responses at most 2 MiB. A request
has `version: 1`, `token`, and `op`. Authenticate before dispatch, using a
constant-time comparison with `O8D_SUPERVISOR_TOKEN`. The socket directory and
state directory must be real directories owned by the daemon uid with no group
or other permissions; the socket is mode 0600. Linux peer credentials must match
the daemon uid. This is a local operator capability, never a worker API. Errors
are fixed codes, with no command, environment, output, paths or credentials.

## Operations

* `spawn`: `id` (unique run id), `owner` (stable surface id), absolute `command`,
  string `args`, explicit `env`, absolute `cwd`, `stdoutPath`, `stderrPath`, and
  optional `stdinPath` (regular file) and `admissionPath` (the existing private
  work-launch reader). The daemon transfers that reader to its own boot/start
  identity before exec, checks restart admission and retains it through exit.
  No shell or inherited environment. Files
  are opened without following symlinks. The child creates a new session and
  process group before exec. Persist a private ownership record before replying
  `{ok:true,id,pid,identity,epoch}`. Duplicate ids refuse, including after daemon
  restart; uncertain submission must be reconciled with attach, never respawned.
* `attach`: `id`, `owner`, `since` (last committed sequence, initially zero).
  Returns `{ok:true,id,pid,identity,epoch,events,cursor,gap,state}`. Each output
  event has `seq`, `stream` (`stdout`/`stderr`), and base64 `data`, preserving
  arbitrary bytes and split UTF-8. Sequence orders capture, not execution across
  the two OS pipes. An exit event has `seq`, `code` and numeric `signal` (one is
  null). `cursor` advances only through returned events. Future cursors refuse.
  States are `running`, `draining` (leader exited, group/output still held),
  `settling` (reap and durable receipt in progress), `exited`, or `lost`.
* `signal`: `id`, `owner`, `epoch`, `signal` (`SIGINT`, `SIGTERM`, `SIGKILL`). Only the
  original daemon's child actor can send a group signal. Immediately before
  signaling it verifies the persisted record against its in-memory receipt and
  the leader's kernel boot/start cookie, session and group. The actor serializes
  signaling and reaping, so an unreaped child pins the group id against reuse.
  Missing, changed, foreign, exited or unverifiable ownership always refuses.

## Replay, exits and reattachment

Each process has a 1 MiB ring budget charged by serialized event bytes (16 KiB
reads), independent of clients. This bounds both raw output and JSON overhead.
Slow/disconnected clients never block pipe draining. Overflow evicts oldest
output and sets `gap:true` when `since` predates retained output; durable run
files remain authoritative for the full transcript. Exit is retained separately
and cannot be evicted by output. Pipe EOF precedes the terminal receipt. One
waiter reaps each child and creates exactly one immutable exit event and private
persisted exit record. Repeated attach returns that same sequence, never a new
exit. Consumers commit the cursor and exit effect together in session metadata;
transport retries are replay, not additional exits. There is no claim of
exactly-once network delivery without a committed consumer cursor.

A prepared journal saves id/owner before submission, with an empty epoch until
the receipt binds. If that reply is lost, a new server recovers that exact id by
authenticated attach, binds the returned pid/identity/epoch and never respawns.
An absent or unavailable daemon record keeps the intent unresolved. A new app
server reads a bound id/owner and calls attach with its saved cursor.
It needs neither the previous server pid nor its pipes. Output files keep growing
while the app is absent. A daemon restart preserves the ownership inventory and
terminal receipts but loses live pipes/rings; prior running records are `lost`,
never adopted or signaled, and require operator reconciliation. This slice does
not claim supervisor-crash recovery. Admission is capped at 128 retained records;
there is no automatic eviction of ownership evidence.

## TypeScript selection and scope

`O8_PROCESS_SUPERVISOR=1` and `O8D_SUPERVISOR_SOCKET` select the native Codex
owned batch launch path on Linux. The daemon credential is the app's existing
WS operator credential, supplied privately as `O8D_SUPERVISOR_TOKEN` at daemon
startup. Controlled/single-attempt and carried launches retain their existing
policy boundary. Other launches and absent opt-in retain the current child
process path. An opted-in supervisor failure refuses launch; it never falls
back to a duplicate worker. App update admission and credential/environment
checks still run before command submission. Live stdin, PTYs and ACP are outside
this finite-input slice.

The leader remains unreaped while descendants retain output pipes or keep
running with redirected output. Linux subreaping lets the daemon reap orphaned
members of its own groups. Stop can verify and signal the original group
throughout this drain. Before terminal settlement, a signal-zero kernel probe
must report ESRCH for the group; EPERM or an unexpected surviving group retains
admission and refuses numeric signals. `groupEmpty` reports this same absence
proof after exit. Escaped sessions remain outside this group's signal authority.

Run `cargo test --locked --manifest-path crates/o8d/Cargo.toml --all-features`
and `npx vitest run tests/o8d-supervisor-real-path.test.ts` for fixture evidence.

For measurements, build with `--release --features experimental-supervisor`,
set `O8D_TEST_BINARY` to that binary, then run
`node --import=./scripts/register-server-only-stub.mjs --import=tsx scripts/bench/process-supervisor.ts`.
The isolated Node host calls the production credential/admission launch entry.
It measures launch submission to first observed output-file byte with 1 ms
polling, and Node event-loop active milliseconds through exit and artifact
consumption for 1 MiB. Native IPC, replay parsing and reconciliation are included;
Rust CPU is excluded. Five warmups and 30 paired samples per path/workload
alternate order. This is fixture performance, not a whole-app speedup claim.
