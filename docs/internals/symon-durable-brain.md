# Symon durable brain

Symon can answer text on the built-in Pi agent and the o8 managed model, with
every conversation kept in a durable store. An install with no agent CLI, and a
desktop whose bridge is not running, can still answer.

Source: `src/lib/symon/durable/`.

## Store

- One Pi Durable store per o8 data directory: `<data dir>/symon/durable.sqlite`
  (`@earendil-works/pi-durable`, SQLite through `node:sqlite`).
- Only the o8 server process opens it. Pi Durable has no cross-process locking,
  so no other process may open the same file.
- A session document, `symon.directory`, maps each thread key to its
  conversation, with the source (`messages`, `phone`, `voice`, `app`), title and
  timestamps.
- One conversation per thread. A managed-message thread uses its
  `conversationId` as the key, for example `imessage:direct:<handle>`.

## Turns

- `SymonBrain.send()` admits one input under the caller's request id and waits
  up to the caller's window. A repeated request id returns the same submission,
  so a retried delivery never starts a second model turn.
- Every input and model turn is committed before it is shown. After a restart,
  the next send or `resume()` continues an unfinished turn from its checkpoint.
- Retries are off (`retry.maxRetries: 0`). The managed transport makes one
  attempt, and a failed turn is reported.
- Compaction is on with a 24,000-token window, so a long thread is summarized
  before a request grows large. Background compaction is off.
- A failed turn shows only o8's allowance text, when the managed relay reports
  an exhausted allowance, or a fixed reply. Provider text never reaches the
  sender.

## Model access

`createSymonManagedProvider()` registers the managed model as a pi-ai provider
whose streams call `createManagedPiTransport()`. The route and its credential
headers are resolved by the host for each call and never enter the store.

## Brain selection

`<data dir>/symon/text-brain.json` holds the mode, read for each new turn and
set through `GET`/`POST /api/panel/symon/text-brain`:

| Mode | Behavior |
|---|---|
| `auto` (default) | The native planner when its desktop bridge answers and a planner CLI is installed; otherwise the Pi brain. |
| `pi` | Always the Pi brain. |
| `planner` | Always the native planner. A missing CLI returns `503 no_cli` as before. |

## Managed messages

`POST /api/symon/managed-messages/inbound` routes a direct or full-access group
turn to the Pi brain by the mode above. Its session id is
`pi-brain:<conversationId>`. When the thread's earlier turns were answered by
the planner, the last twelve are passed to the Pi brain as data with the new
message. A Pi turn that a restart interrupted is finished on the next delivery
instead of being answered with a request to send it again. Limited-access
shared groups keep their tool-free path.

## Current limits

- The Pi brain has no tools yet. It cannot act on the computer or change o8, and
  its prompt says so.
- The phone text session and voice transcripts do not use the store yet.

## Tests

- `tests/symon-durable-brain-real-path.test.ts`: answer, duplicate delivery,
  per-thread context, restart on the same store, bounded failure text, and the
  managed request body.
- `tests/symon-managed-messages-pi-brain-real-path.test.ts`: the inbound route
  on each mode, planner-to-Pi context, and a restart mid-turn.
