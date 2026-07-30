# Crash survival and recovery

o8 keeps worker and orchestrator processes independent of the web servers that display them, then reconstructs control-plane state from durable records after a restart.

## Survival model

Dispatched workers run as detached process groups by default. Their transcripts stream to durable JSONL files, while the owned-session record stores the active process identity and lifecycle state. On boot, reconciliation probes the process before any stale-lane cleanup; a live process is rebound to its lane instead of being finalized.

In-flight orchestrator turns use the same principle with records under `~/.o8/orchestrator-turns`. Interactive terminals are separate: they use tmux and are documented in [Persistent terminals](../user/persistent-terminals.md).

## Default flags

- `O8_CRASH_SURVIVABLE_WORKERS=0` restores the legacy process-bound worker bridge.
- `O8_CRASH_SURVIVABLE_ORCHESTRATOR=0` disables detached orchestrator turns.
- `O8_PERSISTENT_TERMINALS=0` disables tmux-backed interactive terminals.

The unset default is enabled for all three paths. A host that cannot create the required detached or tmux session falls back through the existing launch path and must not claim crash survival.

## Recovery sequence

1. Boot reads durable session and lane state.
2. Liveness probes check process groups and tmux sessions.
3. Live workers and turns are rebound before orphan or silent-exit cleanup.
4. Persisted transcript data repopulates the operator surface.
5. Dead runs are finalized or surfaced for recovery through the normal lane state machine.

The ordering matters: cleanup must never archive a process that is still alive and reattachable.

## Operational checks

- `o8 status` shows whether lanes returned to their expected lifecycle state.
- `o8 doctor` checks the local servers, configuration, and stale processes.
- The owned-session JSONL should continue growing while a detached worker runs, even when the app is down.
- A recovered lane must retain its prior session identity and transcript; a fresh session presented as a recovery is a failure.

Use destructive kill tests only in an isolated profile. Start a bounded worker, record its PID and transcript path, terminate the app and WebSocket server, relaunch, then verify that the original PID survived and the original lane resumed without salvage.
