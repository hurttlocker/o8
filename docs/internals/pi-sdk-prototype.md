# Managed Pi SDK prototype

This began as an opt-in server-side prototype under issue #3230. Since #3258 it
backs the `pi` orchestrator backend (see "Orchestrator" below), offered in the
composer under Customize leads as a preview, and the `pi-builtin` packet worker
runtime (see "Worker" below). Neither is the default, and neither is part of
native first-run acceptance. The external Pi CLI runtime (`pi`) is unchanged.

## Entry point and ownership

`createPiSdkSession` in `src/lib/pi/sdk/session.ts` starts the full pinned Pi SDK
in an on-demand child through the existing `StdioJsonRpcPeer`. The caller must
already have authority over the canonical workspace, a separate private state
directory, the selected managed model, and any injected host adapters. This API
must not be wired directly to untrusted request parameters.

The worker receives only model metadata, three tool definitions (`read_file`,
`write_file`, `run_command`), and owned session paths. It does not inherit provider credentials, `NODE_OPTIONS`, proxy settings,
user extensions, project instructions, or user Pi settings. Stock tools and
resource discovery are disabled. Read, write and command requests return to the
host.

The host reuses descriptor-based workspace file IO and the existing approval
inbox. Writes show the exact proposed content and the existing content when
present. Existing files stay open across approval; path, identity and content
changes cause rejection. The narrow prototype refuses symlinks, hard-linked
files, `.git`, and `.env` paths. Reads and writes are bounded to 50 KB. These
application controls are not an OS sandbox and do not contain a compromised
worker process or arbitrary third-party code. No third-party code is enabled.

A restored session uses `prompt`, not queue-only `follow_up`. It must belong to
the same workspace and owned state directory. Session IDs remain stable across
restart. Host results require `agent_settled`; an accepted command or an
`agent_end` event alone is not completion. Failed and aborted outcomes retain
their stop reason and cannot reuse text from a previous turn. Stop cancels host
model/tool work before asking the worker to abort; close uses the shared
cooperative-to-forced child shutdown ladder.

## Command tool

`run_command` (#3257) goes through `evaluatePolicy`, the same rules as every other
runtime's shell tool. A blocked command never starts. Every other command needs
an exact one-shot approval in the inbox unless an operator policy rule (for
example a workspace-scoped `mutation-shell` override in `policies.json`) lifts
it. A denied or expired approval never starts the command.

The host runs `/bin/sh -c` at the workspace root in a new process group. Its
environment is an allowlist (`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, locale
and `TMPDIR`, plus non-interactive pager and Git settings), so provider keys, host
tokens, o8 internals and the SSH agent socket are not inherited. The launcher
checks that its physical working directory is still the workspace before the
command starts, so a root replaced by a symlink after the host's checks is
refused. Stdout and stderr share one 50 KB buffer; any output past it stops the
command. The default limit is 120 seconds, set by the host only.

Ending a command depends on the platform:

- Linux: the command runs under the native supervisor (`o8-pi-write supervise`,
  #3350). It marks itself a child subreaper, so a descendant whose parent exits
  is reparented to the supervisor, whatever process group or session it moved
  to. On the command's exit, on SIGTERM from the host (timeout, output cap or
  Stop), or when the host dies (parent-death signal), it sends TERM to every
  descendant found from `/proc`, waits 1.5 seconds, then sends KILL until
  `waitpid` reports no child. Signals go through pidfds checked against each
  process's start time, so a reused pid never receives one; the supervisor
  refuses to start a command when pidfds are unavailable (Linux before 5.3, or a
  seccomp policy that denies them). It writes a receipt on a separate descriptor that
  the command never sees. A missing or unconfirmed receipt fails the call and
  refuses later commands and writes until o8 restarts.
- macOS has no subreaper. The host reads the process table every 250 ms while a
  command runs and tracks the process group and every descendant by pid and
  start time. Reads may overlap; a result older than the last one applied is
  dropped. Once a read shows the group empty, its number is no longer used to
  adopt processes, because it may have been reused. The timeout, the output
  cap, Stop and a normal exit each send TERM, then KILL on a fixed schedule. If
  the table cannot be read, the group still gets TERM and KILL, the call fails,
  and later commands and writes are refused until o8 restarts.

Pi runs tool calls from one message in parallel by default. The host runs one
tool call at a time per session, and one command or write commit at a time
across every Pi session in the host process, so no command process is alive
while an approved write commits. Stop ends a call that is still waiting for its
turn without running it.

Known limits: approval is the boundary, not a sandbox. An approved command can
read anything the user can, including files under `HOME`. On macOS, tracking
comes from process-table snapshots, so a descendant that moves to a new process
group and outlives its parent can be missed: when it leaves and is reparented
between two reads, when a read that saw it is dropped as older than teardown's
read, or when a scan taken around a fork shows the group empty. A missed process
keeps running after the tool call. On Linux, a process stuck in uninterruptible
sleep past the 5-second KILL deadline leaves the receipt unconfirmed, which
refuses later commands and writes. Work handed over IPC to a service outside
the tree (systemd, an already running daemon) is not ended. After exit, the host
waits at most 1 second for buffered output, so output still in flight after that
is dropped. The lock covers one host process, not other
processes writing the same workspace.

`tests/pi-sdk-command-real-path.test.ts` covers inbox approval and rejection,
denial, policy block and operator allow, the working directory, a swapped root,
the environment, timeout, the output cap (including output that fills it
exactly), Stop, a TERM-ignoring child in its own group, a late process-table read, a
reused group number, an unreadable process table, ordering against approved
writes in the same and another session, and Stop while waiting for the lock.
The process-table cases run on macOS only. On Linux, the supervisor cases cover
an orphaned TERM-ignoring child in its own session at exit, timeout and Stop,
the host's death, a host that is gone before launch, and a supervisor that ends
without a receipt.

## Orchestrator

`src/lib/lane/orchestrator-backends/pi.ts` registers bundled Pi as the `pi`
orchestrator backend (#3258). It runs one turn at a time per repo and thread; a
message that arrives while a turn is running or starting is refused. Each thread
has one Pi process, and its session file lives under `<data dir>/pi/orchestrator/`,
so a new process after a restart, a failure or a 15-minute idle close resumes the
same conversation. Stop aborts the run and the next message is accepted. A failed
run closes the process and the next message starts a new one on the same session
file. A turn that needs a different tool surface gets a new process.

Pi gets the built-in o8 servers that the Claude orchestrator surface gets for
the same repo and tool profile, from the same tool-spine entries:

- the operator server, reached the way the operator stdio proxy forwards every
  message: a JSON-RPC POST to `/api/mcp` with the ws token;
- cortex, launched as a stdio MCP server from its tool-spine entry. A proposer
  turn gets it read-only and no operator server, as Claude does.

A plan-mode turn is read-only: it gets the proposer projection, and of Pi's own
tools only `read_file`.

User-configured external MCP servers are not attached to Pi.

The servers list 152 commands when this was written (125 from the operator server
and 27 from cortex). The operator server's schemas alone are about
110 KB, which would ride on every model call. Pi instead gets three host tools:
`o8_commands` lists commands with a one-line summary, `o8_command_help` returns
one command's description and argument schema, and `o8_run` runs a command with
its arguments as a JSON object string (a string, because some providers reject
an object parameter that declares no properties). The system prompt is the
shared `orchestrator.md` prompt plus the list of command names. Claude sees each
server's tools under that server's name, so a name listed by two servers stays
two commands: the operator's `cortex_ask` and cortex's `cortex.cortex_ask`.
A command result is capped at 40 KB. Calls reach the servers unchanged, so their
own checks apply as for every other orchestrator. Transport errors, which can
carry server stderr, go to the host log; Pi and the stream get a fixed message.
A server's own error result reaches Pi exactly as it reaches Claude, including
any API error text the server put in it (#3373).
A start failure is shown only when o8 itself explains it (unsupported Node or
platform).

Pi's own `write_file` and `run_command` in the repo keep per-call approval in the
inbox. Per-turn limits are 40 model calls, 80 tool calls and 30 minutes.

`tests/pi-orchestrator-real-path.test.ts` serves the real `/api/mcp` route over a
local HTTP server behind the real middleware gate, which refuses a request
without the ws token. It spawns every built-in server in the Claude
orchestrator's emitted MCP config and checks that Pi's production path reaches
the same commands on the same servers with the same schemas, and that a proposer
turn drops the operator server. It then drives turns through the backend with a
scripted model: command help, a real operator command, an unknown command, an
approved write, resume in a new backend, the used-up allowance message, Stop
followed by a new message, a read-only plan turn, an overlapping message, shutdown
while Pi is starting, idle close, and a transport error that must not reach Pi.

## Worker

`src/lib/runtimes/pi-builtin.ts` registers bundled Pi as the `pi-builtin` worker
runtime, labeled "Pi (built-in)" in the runtime catalog, so it appears in the
dispatch runtime options. It is a separate runtime from the external `pi` CLI and
is not the default dispatch runtime. Its owned-session store is
`src/lib/pi-builtin/owned.ts`, with session keys `pi-builtin-owned:<id>`.

A packet dispatched to it gets a managed worktree like any other worker. Each
turn starts one Pi process with that worktree as its workspace, on the managed
model route, and closes the process when the turn settles. A follow-up turn
starts a new process on the newest session file, so the conversation continues.
Session metadata, run logs and Pi's state live in
`<data dir>/owned-pi-builtin/<id>/`, outside the workspace. The worker process
gets no credential. The requested model does not change the route: the session
records the one managed model.

The orchestrator and the packet worker both run on `O8_MANAGED_PI_MODEL`
(`openai/gpt-6-luna`, `src/lib/pi/sdk/live-contract.ts`). The hosted endpoint
forwards it to OpenAI on paid plans and replaces it with its free model on the
free plan. Its Chat Completions accepts tools only with reasoning effort `none`,
which the endpoint sets, so Pi sends no reasoning field.

Lane rules govern a packet worker (`src/lib/pi/sdk/lane-approval.ts`). Inside
its lane worktree, `write_file` and `run_command` get no per-call inbox approval,
as for every other worker. The command policy still runs first, so a blocked
command never starts. A call is allowed only while the lane is open and still
bound to the session's workspace, and a write path must resolve inside it. That
lane authority is a separate, mandatory check: the host repeats it inside the
host-wide lock immediately before a write commits or a command starts, whatever
approval or an operator policy rule said, so a call approved or queued earlier
cannot outlive its lane. Review and merge stay the gate. A launch without a lane
keeps per-call inbox approval. A read-only packet is supported and gets
`read_file` only. The orchestrator backend keeps inbox approval for its own
writes and commands.

A turn is owned from before its Pi process starts until it settles. Stop during
startup marks the turn stopped; before sending the prompt, the turn checks that
it is still the session's current run and was not stopped, and otherwise closes
the process and settles once. Discovery during startup leaves the turn running.

When a turn settles, the store records a `runtime_process_exit` lane event whose
classification follows the turn outcome, and a clean finish posts the
supervisor completion signal, as other owned workers do. The adapter advertises
discovery, transcript, launch, resume, interrupt and review diffs. It does not
advertise cost telemetry, because usage counts against the plan or the free
allowance, or streaming, because the transcript is written per finished message
and per tool call. Stop aborts the running turn and closes its process; the next
message resumes the session. A turn cannot be steered while it runs. Per-turn
limits are 40 model calls, 80 tool calls and 30 minutes.

Readiness needs a supported platform, Node 22.19 or newer, the worker script and
the approved-write helper. No install or sign-in is needed; entitlement is
checked on each model call.

`tests/pi-builtin-worker-real-path.test.ts` drives the real delegate route with
a scripted model behind the managed transport: lane, managed worktree, Pi
writing and committing in the worktree with no inbox approval, a policy-blocked
command that never runs, the transcript, discovery, the completion receipt and
supervisor push, review, merge preview and merge. It also covers Stop, resume on
the same session file, inbox approval for a launch without a lane, lane rules
ending with the lane, and an impossible workspace refused before any process
starts. Regression cases cover an approved write that waited on the host lock
while its lane was archived, a command on an archived lane whose approval an
operator rule lifted, Stop and discovery while Pi is still starting, and a
read-only packet through the delegate route.

## Managed inference boundary

`createManagedPiTransport` resolves `resolvePiInferenceRoute()` for every model
request. A paid plan uses its plan token on the managed relay. A free install uses
its free allowance token on the same relay, and requests that token on first use
when it has none. The free route accepts only a token whose plan claim is free,
so a paid install pinned to the free plan fails closed. No token means no
request, and there is no local, BYOK or subscription fallback. Credentials
remain in the host. When the relay reports that the daily allowance is used up,
the run ends after that one call with a plain message in `errorMessage`; there
is no retry. The run result passes on only o8's own failure messages; any other
text, such as an SDK exception, becomes "Pi run failed". Pi's full OpenAI
stream parser handles text and fragmented tool calls, but a host-owned fetch
adapter fixes destination, credential headers, HTTP method and redirect policy.
The desktop UI proxy stream is not used as a model endpoint.

The worker cannot choose the transport, route, model or budget. Defaults are eight
model calls, sixteen tool calls, a 120-second run deadline, a 60-second inference
deadline and a 4096-token output limit. These are prototype anti-runaway bounds,
not a substitute for server-side entitlement, model allowlists or spend limits.
Automatic provider retries, compaction and cache warming are disabled in this
slice. Non-2xx and successful-HTTP SSE errors are sanitized before the worker or
persisted transcript receives them.

## Reproduce offline

Use Node 22.19 or newer for the SDK. The repository currently declares Node 22.x
for its full application gates. The prototype never installs or changes Node.
Approved writes need the native helper in `src-tauri/sidecars/pi-write`; the
tests build it with cargo, so a Rust toolchain is required. After the normal
repository dependency setup, run:

```sh
npx vitest run tests/pi-sdk-worker-real-path.test.ts --maxWorkers=1
npm run test:integration -- tests/pi-sdk-worker-real-path.test.ts
npx tsc --noEmit
npm test
```

The worker fixtures use real child processes and the installed full SDK, with
synthetic model responses or a mocked fetch transport. They do not contact a
provider, consume credits, obtain credentials or claim model quality. Fixtures
cover persistence/resume, Unicode text, approval denial and target drift,
protected aliases, disabled ambient extensions, Stop, budgets, HTTP errors,
SSE-error redaction and fragmented managed tool streaming.
`tests/pi-sdk-free-route-real-path.test.ts` covers the free, paid, no-entitlement,
view-as-free, pinned-plan and used-up allowance routes with signed synthetic
tokens, plus oversized and stalled 402 bodies.

## Platform and concurrency limits

macOS and Linux only: `createPiSdkSession` and the approved-write helper refuse
Windows, which has no tested directory-descriptor write path.

Approved writes go through a native helper (#3289) that works relative to the
verified parent directory descriptor, so it follows the directory if it moves.
The host creates the stage file and holds it open across the commit and every
recovery run, so an uncommitted stage is always wiped through a descriptor and
a hard-link alias keeps no approved bytes. A new file is published with a
no-replace rename. A replacement is one atomic exchange, so the name is never
absent. The helper applies the target's mode, verifies the published inode, its
link count, the parent location and the bytes, and only then reports its commit
point. Rollback only takes the helper's own inode off the name. Other entries are
removed or moved only after being captured under a random name and checked, and
otherwise go back without overwriting. If a signal ends the helper, the host runs
a recovery pass with the captured names and commit point it reported.
`tests/pi-sdk-approved-write-races-real-path.test.ts` drives the real helper at
named points with concurrent renames, links, edits, mode changes and kills.

Known limit: the guarantees hold against ordinary concurrent saves, edits,
renames and links, and against the helper being killed at any point. They do not
hold against a process that deliberately races the helper's own steps:

- rebinding one of its random hidden names between two system calls can misdirect
  a removal, a restoration or a check, because POSIX has no rename or unlink
  conditioned on an inode;
- moving the parent or editing the published file back and forth between the
  checks of the name, the parent and the bytes can make a publication that was
  never whole pass them.

An entry swapped in at the stage name just before publication is published, and
the write is refused. A process with that access can already write the workspace
directly.

## Remaining gates

Before a user-facing integration, bind this API to the existing authenticated
principal, canonical runtime/session registry and durable run receipts. Prove
crash/restart recovery and idempotent command replay through that entry point.
Then verify real managed model allowlists, quota accounting, token revocation,
production approval UX, and signed clean-Mac installation/update behavior.
Package the worker with the app's supported runtime rather than assuming the
source-tree worker path exists in a distribution. An existing compatible Node
installation is a prototype prerequisite; no-Node onboarding is separate work.

None of the offline evidence establishes OS containment, live billing behavior,
a working installed agent, or readiness to change the default.
