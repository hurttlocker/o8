# Detached owned packet workers: slice 2

Slice 2 extends the slice-1 start cookie and source-pinned probes to every
POSIX packet launched by the shared owned batch controller. It does not detach
additional process families. Output remains in the existing per-run files.

| Runtime/path | Lifetime today and slice-2 decision |
| --- | --- |
| Codex owned packets | Detached, ignored stdin, file output. Retains slice-1 identity, fallback and Stop behavior. |
| Claude Code owned packets | Detached, file output, one stream-json input payload. Previously server wrote then closed a pipe. Input now lives in a private per-run regular file, inherited as fd 0 before launch; the worker reads independently after server death. |
| Claude Code metered/controlled gateway carriers | Batch process identity is covered, but `metered-gateway.ts` and `controlled-gateway.ts` host HTTP brokers inside the server. Preserving pending provider requests and those endpoints waits for slice 3; this slice proves the native CLI carrier. |
| Gemini, OpenCode, Cursor, Prime Agent, Muse owned packets | Shared detached batch controller, prompt in argv, ignored stdin, file output. Now capture and verify the same start cookie before rebind and Stop. |
| Antigravity, Copilot CLI, Crush, OpenHands, Goose, Qwen, Qoder, Kimi, Aider, 3code | Current declarative registry entries all use the shared batch controller with prompt in argv and file output. Covered automatically, including future adapters registered through that controller. |
| Claude resident orchestrator/Solo, `lane/orchestrator-session.ts` | Detached with file output when crash survival is enabled, but stdin stays open and receives subsequent turns and approval traffic. Pending callbacks and stream ownership belong to the server. Waits for slice 3. A server-owned FIFO still loses its writer on shutdown; a regular file cannot make an unmodified streaming CLI tail future input. A supervisor must retain the input endpoint, pending protocol state and reconnectable control. |
| Codex orchestrator/Solo, `lane/codex-orchestrator-session.ts` | Detached finite turns with ignored stdin and durable output already survive at the OS level. Uses a separate orchestrator-turn journal and handler/settlement path, not the owned packet store or lane session. Strict turn-journal identity/control rehydration waits for slice 3. |
| Grok, Hermes, DeepSeek Harness | Owned ACP pipe transports require a server-side client, model/tool/approval handling and reconnect state. No detached file-output batch path to extend. Wait for slice-3 supervision. |
| Pi CLI, built-in Pi SDK | Server-owned RPC pipes and callbacks. Wait for slice-3 supervision. |
| Interactive Claude, QA warm/cold pools, native planner processes, direct PTYs | Pipe/PTY lifetime and pending protocol state remain owned by the parent. Wait for slice 3. Dashboard tmux backing sessions already outlive their attach clients. |
| Cloud, remote workers, Magnitude | External worker ownership or operator terminal surfaces; no shared local owned batch launch in this slice. |

The lifecycle registry marks shared batch stores with `detachedPacketIdentity`.
Startup applies strict survivor checks to those registrations; ACP/RPC stores
retain their existing discovery path. Each run persists identity source and boot
and start cookie. Missing, changed or unreadable saved evidence stays held; it
cannot authorize Stop or an automatic replacement. Existing native-helper/ps
fallback and explicit capture-time legacy mode remain unchanged. `ps` fallback
has second-level precision. Stop never escalates using an absent strict leader
or an escaped descendant without a start cookie.

Finite input files are mode 0600 and exclusively created before process spawn.
The child inherits its own descriptor; parent descriptors close after spawn.
`stdinPath` stays with the run and follows archived metadata path rebasing.
Claude's init event now supplies its provider session ID while work is running,
without waiting for a terminal result. Batch launch wrappers retain unknown
side-effect receipts so a refused identity proof cannot turn into a duplicate.

The HTTP proof substitutes only an offline Claude CLI. Production launch,
authentication, storage, lane reconciliation, output parsing and Stop routes are
used. The worker delays reading stdin until the launching server is dead, then
continues through TERM and KILL restarts with the same PID/start cookie, provider
session, lane and launch receipt. Transcript output grows while no server runs.
Missing, changed and unreadable identities refuse rebind and Stop. A catalogue
test pins the batch-versus-pipe boundary; a capture matrix covers every current
batch runtime. This is local entry-point evidence, not acceptance of every
external provider binary or an installed-app update.

The broader updater idle guard, native shutdown registry, ROADMAP and release
behavior are unchanged. `Refs #4229` remains open for later slices.
