# Worker continuation runbook

How a dispatched worker's conversation is continued, what survives, and what a refusal
means. Mechanism-level; runtime names appear only as source paths. Sources:
`src/lib/claude-code/owned.ts`, `src/lib/runtimes/claude-code.ts`,
`src/lib/orchestrator/operator-mission-service/{steer,reset,rerun-with-feedback}.ts`,
`src/lib/runtimes/shared/owned-session/{store,stop-outcome}.ts`, and the real-path
regression `tests/owned-claude-continuation-real-path.test.ts`.

A dispatched worker is an **owned session**: o8 spawned the process, so it holds a
durable `session.json` with the provider's saved conversation id plus the model, effort,
identity and runtime pins. Continuation resumes *that* saved conversation, never a new
conversation aimed at the same worktree.

## Exact saved-session continuation

- Continuation addresses the saved conversation id from the session record. Never a
  session name, never a path, never the runtime's most-recent-session fallback.
  `resumeArgs` validates it against a strict UUID shape and throws before argv exists:
  "The saved session ID is invalid. No continuation was started."
- Resume argv carries `--resume <saved-id>` and never `--continue`. The regression
  asserts turn 1 has no `--resume`, every later turn resumes the same id, and no turn
  ever passes `--continue`.
- An archived session is cold-restored and its saved id resumed in a fresh process. The
  note says so ("no warm context beyond the thread") so cost expectations stay honest;
  a failed run rolls the restore back.
- Continuity is observable: three turns driven through the real runtime action, and the worker sees all three prompts in order, warm and after archiving.

## What is preserved

Per-turn callers re-supply none of this; the session record is the pin.

| Preserved | Why it matters |
|---|---|
| Model and effort | A continuation cannot silently downgrade the assigned tier. |
| Session identity | Same owned address; no second session is created. |
| `runtimeConfig` (carrier, work mode, spend cap) | A read-only packet stays read-only on resume even when the caller knows nothing about work mode. |
| Isolated config dir + credential env | Same private grant and scratch dir every turn, not a shared temp path. |
| Working directory | Every turn runs in the packet's own worktree. |

## Busy: an active turn refuses new input

Overlapping input is refused, not queued or raced: an active run with a live pid
("…still has an active run. Wait for it to settle or interrupt it first."), a run still
in the `prepared` spawn state (held until marker reconciliation resolves it), an empty
follow-up message, and any discovered surface, which is not owned and must be continued in
its original client. None of these spawn a process; the regression proves it by
asserting the invocation count does not grow.


## Missing session or transcript fails explicitly

There is no "start fresh instead" fallback on this path.

- Unknown surface id: "Owned … session was not found."
- No saved conversation id yet: resume unavailable, stated as such.
- Saved id the provider no longer has: the turn is attempted and recorded **failed** with
  the child's non-zero exit. The saved id stays; o8 opens no new conversation to cover it.
- After a steer, `steer.ts` reads the stderr head of the run *this* steer started and
  reports "Steer failed to start: …" instead of claiming success.

## Stop is a deliberate interruption, not an automatic restart

Nothing converts a Stop into a fresh conversation on its own.

- Stop labels only the exact run whose signal landed (`stop-outcome.ts` matches run id,
  pid, process marker and process group under the session lock). A run that changed
  before Stop took the lock is not signaled at all.
- An absent process or denied signal is not an intentional interruption, and an
  **unrequested** signal exit stays `failed`. Stop is never inferred from "the process
  died by signal."
- The session record, its saved conversation id and its pins are not erased by the
  interruption itself, which is not a promise the conversation can be picked back up.
- `o8 packet stop` holds the packet and confirms worker and managed-run death before
  pausing the lane. The higher-level packet Stop route separately schedules lane
  archive and worktree pruning after confirmation; CLI Stop does not promise cleanup.
- While the hold stands, continuation is refused: "Packet cannot be steered while
  operator_stopped." A steer is not authority to undo an operator stop, an archive, or
  a proven release.
- The only paths that clear the hold are the recovery verbs, and both null the packet's
  lane binding instead of resuming its conversation (`reset.ts`, `rerun-with-feedback.ts`).
  Reset returns the packet to draft and needs a fresh dispatch; rerun archives the stale
  lane and launches a new worker. Reset clears the worktree, retry keeps it.
- Recovery after a Stop is therefore an explicit, potentially destructive lifecycle
  decision that starts a new worker turn. There is no unhold-and-continue command.

## Operator commands

Verified against `o8 packet --help`, `o8 --help`, and `cli/src`:

- `o8 packet steer --message "<follow-up>"`: continue the warm session (layer-3 escalation).
  Reports `already in progress (not steered twice)` rather than double-sending.
- `o8 packet stop` (alias `o8 packet cancel`): interrupt and hold the packet.
- `o8 packet log --follow`: lane events (`steered_packet`, `steer_failed`). `o8 packet
  info`: packet metadata, status, bound runtime.
- `o8 run -- <cmd>`: run a long command in a terminal the operator can watch.

The MCP `steer_packet` tool and the CLI both route through
`/api/orchestrator/steer-packet`, so lane resolution and the status flip run in the
process that owns the live session pool.

## Regression coverage

`tests/owned-claude-continuation-real-path.test.ts` covers six behaviors through the real
runtime action and real subprocesses with the provider offline: warm continuation, archived
continuation, rejection of discovered/missing/invalid identities, missing-transcript
failure, busy refusal with a verified Stop, and the unrequested-signal case. Companions:
`sandbox-owned-stop-real-path.test.ts`, `completion-steer-race-real-path.test.ts`. Keep
classification current with `node scripts/classify-tests.mjs --check`.
