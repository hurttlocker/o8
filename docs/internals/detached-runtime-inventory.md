# Runtime restart inventory for #4229

Design-only inspection of source commit `d34f15e7267258d215d7a5b7a0cc425883f7c1c8`.
The [proposal](detached-runtime-design.md) is the draft PR body. No runtime code changed.

## Findings and measurements

The premise that every worker is attached to the server does not match this source revision. Packet launches pass through `commands-launch.ts`, `runtime/actions.ts`, and the runtime registry. The Codex and Claude Code adapters use the shared owned-session store, whose default is detached spawning with output files. Solo dispatch uses the separate orchestrator-backend registry. Its Codex and Claude paths also enable crash survival by default. These paths still need stronger identity checks and a real worker-plus-lane restart test.

The remaining ownership problem is concrete for direct PTYs, interactive stream-JSON sessions, ACP, Pi RPC, and SDK transports. A new session alone cannot transfer their existing input, output, protocol state, or PTY master to a replacement server.

Measured locally with existing tests and installed dependencies, without restarting the installed app:

- `vitest run --config config/vitest/vitest.integration.config.ts tests/dash-terminal-restart-real-path.test.ts`: 4 passed, 8.10 seconds. A real WS server stopped and restarted; the same interactive program continued its heartbeat during downtime, retained its identity, answered input after reattachment, and restored scrollback through tmux.
- `vitest run --config config/vitest/vitest.integration.config.ts tests/crash-survival.test.ts src/lib/ws-server/terminal-host.test.ts`: 11 passed, 1.49 seconds. Includes real fork/PTY round trips. The crash-survival assertions use the test runner PID; they do not launch a packet, restart its server, or prove lane reattachment.
- The initial unit-config selection excluded those resource-owning tests and ran none; the integration selection above is the executed receipt.

## Spawn sites

Stdio is ordered stdin/stdout/stderr. "Inherited group/session" means the spawn site requests neither `detached` nor a new process group; this is a source trace, not a process-table capture for every runtime. "File" means a descriptor opened before spawn, not a server callback that copies a pipe into a file. Runtime probes and finite helpers are distinguished from user work below.

| Site | Consumer and lifetime | Stdio | Group/session | Output reader |
| --- | --- | --- | --- | --- |
| [owned-session/run-controller.ts:707](../../src/lib/runtimes/shared/owned-session/run-controller.ts#L707), also :714 | Packet and owned CLI workers; direct path is default | payload pipe then end, or ignore / append file / append file | `detached: true`, `unref`; own POSIX group/session | Owned store parses run files; fleet/transcript consumers poll durable tails |
| [owned-session/run-controller.ts:670](../../src/lib/runtimes/shared/owned-session/run-controller.ts#L670) | Legacy worker bridge when crash survival is disabled, with direct fallback | PTY shell; CLI stdout via `tee` to file; stderr file redirects `tee`, while CLI stderr stays on PTY | PTY child session owned by WS host | PTY events to WS; owned store also reads files |
| [codex-orchestrator-session.ts:611](../../src/lib/lane/codex-orchestrator-session.ts#L611) | Codex orchestrator and Solo turns | ignore / file / file by default; output pipes with crash flag off | Detached and unref by default; Solo also requests a separate group | File tailer to JSON event handler, or pipe handlers |
| [orchestrator-session.ts:855](../../src/lib/lane/orchestrator-session.ts#L855) | Resident Claude orchestrator and Solo warm process | pipe / file / file by default; all pipes with crash flag off | Detached and unref by default; stdin still belongs to server | Per-process file tailers and stream-JSON event handlers |
| [claude-code/interactive-session.ts:377](../../src/lib/claude-code/interactive-session.ts#L377) | Interactive chat tab process | pipe / pipe / pipe | Inherited group/session | `attachProcessHandlers`; session map and active turn are in memory |
| [acp/client.ts:246](../../src/lib/acp/client.ts#L246) | Owned ACP workers and ACP orchestrator/Solo backends | pipe / pipe / pipe | Inherited group/session | `AcpClient` JSON-RPC parser; callbacks append owned run logs |
| [pi/owned.ts:308](../../src/lib/pi/owned.ts#L308) | Owned Pi CLI RPC worker | pipe / pipe / pipe | Inherited group/session | RPC parser in server appends JSONL and stderr files |
| [shared/stdio-json-rpc.ts:87](../../src/lib/runtimes/shared/stdio-json-rpc.ts#L87) | Built-in Pi SDK worker and MCP stdio peers; SDK caller at `pi/sdk/session.ts:111` | pipe / pipe / pipe | Inherited group/session | `StdioJsonRpcPeer`; server owns model/tool callbacks |
| [codex/app-server-client.ts:65](../../src/lib/codex/app-server-client.ts#L65) | App-server utility connections for transforms, capacity and sync | pipe / pipe / pipe | Inherited group/session | Client JSON-RPC parser; bounded stderr tail in memory |
| [codex/app-server-exec-bridge.ts:93](../../src/lib/codex/app-server-exec-bridge.ts#L93) | Codex app execution bridge's child | pipe / pipe / pipe | Inherits bridge group/session, which can already be detached | Bridge parses RPC and emits exec-shaped JSONL to its own stdout |
| [terminal-host-client.ts:145](../../src/lib/ws-server/terminal-host-client.ts#L145) | Forked PTY host | ignore / inherit / inherit, plus IPC | Inherited group/session; no detached option | Server consumes IPC terminal events; diagnostics inherit server sinks |
| [terminal-host-client.ts:47](../../src/lib/ws-server/terminal-host-client.ts#L47) | Inline PTYs, including direct shells and tmux attach clients | PTY slave for all three | node-pty creates a child session; server retains master | WS `registerTerminalAttachment` consumes `onData`, buffers and fans out |
| [terminal-host-entry.ts:37](../../src/lib/ws-server/terminal-host-entry.ts#L37) | PTYs inside forked host | PTY slave for all three | node-pty child session; forked host retains master | Host forwards `onData` over IPC; server buffers and fans out |
| [dash-terminal-persistence.ts:105](../../src/lib/ws-server/dash-terminal-persistence.ts#L105) | Dashboard and action-plugin backing terminals | tmux CLI capture; command itself uses tmux-owned PTY | `tmux new-session -d`; backing server/session independent of WS | tmux history/capture-pane, attached through disposable PTY client |
| [cli/commands/run.ts:453](../../cli/src/commands/run.ts#L453) | Managed `o8 run` commands | tmux CLI ignored; command uses tmux-owned PTY | Independent tmux session; persisted pane PID/group/marker | `pipe-pane` appends durable log; CLI/server readers consume log and exit receipt |
| [claude-code/warm-repl-pool.ts:98](../../src/lib/claude-code/warm-repl-pool.ts#L98) | Prewarmed QA processes, acquired for one turn | pipe / pipe / pipe | Inherited group/session | Stream parser buffers events or calls active observer; stderr drained and discarded |
| [claude-code/one-shot-repl.ts:96](../../src/lib/claude-code/one-shot-repl.ts#L96) | Cold one-shot QA turn | pipe / pipe / pipe | Inherited group/session | Stream parser accumulates result; stderr bounded in memory |
| [cortex/qa/llm/codex-adapter.ts:227](../../src/lib/cortex/qa/llm/codex-adapter.ts#L227) | Codex QA turn | pipe / pipe / pipe | Inherited group/session | Server buffers diagnostics and reads final-answer file |
| [openclaw.ts:376](../../src/lib/lane/orchestrator-backends/openclaw.ts#L376) | Optional local gateway if none is listening | ignore / pipe / pipe | Inherited group/session | Server logs both streams |
| [openclaw.ts:748](../../src/lib/lane/orchestrator-backends/openclaw.ts#L748) | Gateway-backed orchestrator turn | ignore / pipe / pipe | Inherited group/session | Server accumulates final JSON and stderr in memory |
| [auto-compact.ts:160](../../src/lib/orchestrator/auto-compact.ts#L160) | Finite compaction CLI call | prompt pipe or ignore / pipe / pipe | Inherited group/session | Server collects compaction text and diagnostics |
| [agent/claude.rs:235](../../src-tauri/src/agent/claude.rs#L235) and [agent/codex.rs:401](../../src-tauri/src/agent/codex.rs#L401) | Native planner sessions, including `claude_pool.rs`; separate from server workers | pipe / pipe / null | Inherited native group/session | Native buffered readers; `Drop` explicitly kills and waits |

The task pool is scheduling state, not an additional process launcher. The resident orchestrator process and QA warm pool above are different pools. Unused warm slots have no user turn to preserve and may be discarded; an acquired slot has active work.

Additional dependencies: `codex-subscription-proxy.ts:247` uses ignore/file/file and `unref`, but no detached option. `acp/preparation-process.ts:13` and `pi/sdk/command.ts:117` launch a detached native supervisor with ignore/pipe/pipe plus fd 3 receipts; that supervisor deliberately tears down descendants when its owner exits. `pi/sdk/approved-write.ts:49` uses stdin plus passed directory/staging descriptors for a finite publication step. Capacity/catalogue/preflight probes are finite CLI requests, not live worker identities. Remote worker-agent scripts own their own subprocess lifecycle and are outside the app-server spawn path.

## What restart ends today

Slice 1 native ownership contract: `supervise_next_sidecar` registers the PID
returned by the bundled Node server's `Child::id()`. Its generic restart loop
registers the replacement server's `Child::id()`. The only two production callers
are `spawn_and_supervise_bundled_next` and `spawn_and_supervise_bundled_ws`;
their commands run the bundled Node binary with the respective server entry.
Neither Node worker launch nor its PID crosses into this registry. On Unix the
quit and update cleanup signals these positive PIDs, never their process groups.
Detached Codex packet workers therefore survive this native cleanup boundary.
`tests/native-worker-shutdown-contract.test.ts` pins both registration sources,
both callers, replacement registration, and the TERM/KILL argument boundary.

- [Native startup](../../src-tauri/src/lib.rs#L6920) starts bundled Next and WS children with ordinary `Command::spawn`, no new session/group. Next stdout/stderr go directly to append logs (null fallback); WS stdout/stderr are pipes read by native capture threads into logs. Stdin is inherited. Registered sidecar PIDs are watched by native threads that can respawn them.
- [Native exit](../../src-tauri/src/lib.rs#L9334), panic and signal cleanup use [sidecar lifecycle](../../src-tauri/src/sidecar_lifecycle.rs#L248): TERM each positive registered server PID, wait one second, then KILL survivors. This Unix path is not a recursive process-group kill. Comments about group termination do not establish that every child receives TERM. An already verified desktop-attached daemon is explicitly left running. Update `RestartSafety` calls the same cleanup after admission.
- [WS shutdown](../../src/ws-server.ts#L9947) explicitly calls every attachment's PTY `kill()`, disposes the terminal host and exits within three seconds. Installed node-pty's Unix `kill()` defaults to SIGHUP. Killing a tmux attach client leaves its backing session alive; a plain shell loses its actual terminal.
- [Forked host](../../src/lib/ws-server/terminal-host-entry.ts#L59) calls `killAll()` and exits on both IPC disconnect and TERM. Abrupt server death therefore also ends its direct PTYs. Inline host death closes its PTY masters.
- Pipe-owned transports lose the only stdin writer and stdout/stderr readers when the owning server exits. Runtime-specific EOF or broken-output handling may terminate them; even a surviving PID has no reconnectable transport. There is no universal server shutdown loop killing all detached CLI workers. Explicit interactive/RPC close, idle, timeout and cancellation paths also signal processes, but those are distinct from OS parent exit.
- The detached Claude resident process still has server-owned stdin. Its output survives in files, but preserving a live REPL and pending protocol state requires a longer-lived I/O owner. SDK model/tool brokers must also move with their transport; detaching only the SDK subprocess is insufficient.

## Existing durable state and gaps

At the inventory baseline, owned sessions persisted surface, lane, packet,
provider thread, run identity, prepared/started spawn journal, PID, process group,
inherited marker, output paths, outcome and child-exit evidence, but no kernel
start cookie. Slice 1 adds boot identity plus process start time for detached
Codex packets. On macOS the bundled native helper reads `PROC_PIDTBSDINFO`
seconds/microseconds and `kern.bootsessionuuid`. If a dev helper is missing or old,
capture uses the existing metadata-lock probe's second-precision `ps` identity.
The saved `processIdentitySource` pins subsequent probes to the same source,
including after helper installation. Capture brackets the run-marker check with
matching probes. Identified runs stay strict: missing, unreadable or mismatched
identity holds the record through rebind, Stop and orphan sweeping; no PID/cwd
fallback is allowed. If no capture source works, one warning records the reason
and `processIdentityRequired: false` preserves legacy controls for the new run.
Index inference honors that explicit flag. An uncertain launch caused by failed
ownership proof still retains an outcome-unknown receipt against duplicate launch.
Strict Stop rechecks the live leader before each group signal. If that leader
exits or a descendant escapes its group, Stop may remain unconfirmed: this slice
does not signal descendant PIDs without start identities. Supervisor-owned tree
identity and exit receipts remain later work.

Orchestrator turn records retain session name, thread/message identity, PID, log paths, byte offset and settlement; rehydrated liveness uses PID plus a wall-clock ceiling. Interactive session maps, pipe handles and pending requests are memory-only. Owned ACP persists remote session/thread ID and `rpcPid`, but `retireUnattachedProcess` explicitly terminates an unattached survivor before launching another transport. Pi persists session ID/file and logs, but its live RPC client is memory-only. Dashboard tabs have a stable owner-key-derived tmux name and tmux scrollback. Managed runs also persist pane/group/marker, logs and exit receipts.

The updater already has a separate boot/start identity protocol and monotonic 30-second unbound-lease grace. [Merge](../../src/lib/lane/worktree-side-merge.ts#L404) and [PR publication](../../src/lib/lane/commands.ts#L609) use it and hold admission through settlement. Binding only to a live server is not a per-operation recovery proof: the task may have crashed before starting Git. The target needs an operation journal, bounded stale-intent recovery, and verified child identity. A live child or an unresolved publication outcome must defer or require reconciliation, not be erased by a timeout.

## Design constraints and first slice

Use direct detached spawning for existing batch paths. Add a small detached supervisor only for paths that must retain PTY/RPC I/O. It owns runtime pipes or PTY masters, writes output and exit receipts durably, and provides a private reconnectable control socket. Client disconnect must not imply stop. Persist control commands and completion identities so a disconnect does not duplicate a prompt; pending approvals wait safely for the server to return. Keep supervisor executable/support files versioned outside replaceable app resources, with a reconnect protocol version, so an update cannot strand a survivor on lazy imports from a replaced bundle.

macOS facts: [Node detached spawning](https://nodejs.org/api/child_process.html#optionsdetached) creates a new process group/session and requires independent stdio plus `unref` for this use. [setsid](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/setsid.2.html) creates a session without a controlling terminal and rejects an existing group leader; it does not transfer I/O ownership. Installed node-pty uses the macOS setsid spawn flag for PTY children, yet the master remains owned by the caller. Thus detaching only the shell does not solve terminal lifetime. No external `setsid` utility is required.

Prefer boot identity plus kernel start seconds/microseconds for both worker and supervisor. Darwin exposes these fields in [proc_bsdinfo](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/proc_info.h#L54). The approved dev compatibility path uses boot identity plus second-resolution `ps lstart` when no native helper is available; its weaker precision cannot distinguish starts within the same second. Never compare clocks from different sources. Add a per-run nonce handshake for supervisor control. Mismatched or unreadable saved identity grants neither attachment nor signal authority; preserve the record for recovery.

Recommended first implementation slice: harden the existing Codex packet path's identity and startup rebind, and add its missing restart acceptance test. Do not introduce a second batch launcher. Defer PTY/RPC migrations, native planner lifetime, other OS implementations and global idle-guard removal. Once every active-work path has survival proof, replace whole-app idleness with a bounded git/publication drain. This design PR does not close #4229.

Required entry-point tests for implementation:

1. Launch a bounded protocol-faithful worker through the authenticated runtime launch route into a real persisted packet/lane; stop both server processes with TERM, then repeat with KILL. Restart against the same data. Assert original PID and kernel start cookie, provider session ID, lane session key and transcript cursor; output grows while servers are absent; no duplicate launch, recovery approval or lost completion.
2. After reattachment, send continuation/input and Stop through normal routes. Assert they reach only the original identified process and its owned descendants. Replace the recorded start cookie with another process identity and prove attach/stop refuses, even if the PID is alive.
3. For each supervisor migration, repeat through real terminal WebSocket or RPC routes. Exercise offline output beyond pipe capacity, server death during a partial frame, worker exit while offline and subsequent receipt replay. Reuse the existing tmux restart test as a baseline, not as worker/lane proof.
4. Through real merge/publication and native restart admission, hold a live Git child, then crash before Git starts, during Git, and after remote publication before its receipt. Verify bounded intent recovery, outcome reconciliation, no duplicate publication, and no restart while a live mutation remains. A timeout defers restart when proof is incomplete.
