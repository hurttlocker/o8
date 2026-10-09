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

## Phone text sessions

`POST /api/mobile/symon/text-session` binds a new phone session to the Pi brain
(engine `pi`, the managed model, effort `default`) when the mode is `pi`, when
the phone asks for the managed model (`managed-free`), or on `auto` when the
desktop bridge or a planner CLI is missing and the phone named no model. An
explicit native model pin is never replaced. `POST /api/mobile/symon/text-turn`
answers a Pi session on the brain under the key `phone:<sessionId>`, with the
newest message (`text`) only, since the brain keeps the history; the turn id is
the request id, so a repeated poll reaches the same turn. A turn naming another
engine than its session's is refused with `409`. `DELETE` stops a running Pi
turn.

## Conversations API

Panel-authenticated routes over the same store, for the Symon tab:

| Route | Returns |
|---|---|
| `GET /api/panel/symon/conversations?limit=` | Threads from every source, newest first: key, source, title, timestamps. |
| `GET /api/panel/symon/conversations/transcript?key=&limit=` | One thread's user and assistant text, oldest first. `404` for an unknown key. |
| `POST /api/panel/symon/conversations/continue` | Body `{ key, requestId, text }`. Continues a known thread, or starts one under an `app:` key. A repeated `requestId` returns the same turn. `202` while the turn runs. |

An answer to a thread continued in o8 stays in o8; it is not sent back to the
phone or the messaging thread.

## Current limits

- The Pi brain has no tools yet. It cannot act on the computer or change o8, and
  its prompt says so.
- Voice transcripts do not use the store yet.
- The conversations API lists only threads the Pi brain has answered.

## Tests

- `tests/symon-durable-brain-real-path.test.ts`: answer, duplicate delivery,
  per-thread context, restart on the same store, bounded failure text, and the
  managed request body.
- `tests/symon-managed-messages-pi-brain-real-path.test.ts`: the inbound route
  on each mode, planner-to-Pi context, and a restart mid-turn.
- `tests/symon-phone-pi-brain-real-path.test.ts`: phone sessions bound by
  mode, by the managed model and on auto fallback; native pins unchanged; engine
  mismatch refused; repeated polls; Stop.
- `tests/symon-conversations-api-real-path.test.ts`: list, transcript,
  continue, a repeated request id, refusals, and bounded failure text.
