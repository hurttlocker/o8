# Interactive task artifacts

An orchestrator or a dispatched worker can hand the operator a small, purpose-built form inside the thread: a triage table, a ranking, a choose-one. The operator edits it and presses Send, and the exact validated payload arrives back in the session that asked for it, with a receipt. The document is agent-authored HTML, but it gets exactly one capability: return a payload matching a declared schema to the session that created it. It cannot reach o8, the network, or any other session.

This page describes the contract. Code lives under `src/lib/task-artifacts/`, the routes under `src/app/api/task-artifacts/`, and the desktop host in `src/components/desktop/thoughts/chat-panel/TaskArtifactCard.tsx`.

## Lifecycle

1. **Create.** The creator posts `{ title, html, actions, headPolicy? }` plus a target. The server records the artifact with the repository HEAD at creation and, for packet targets, the lane id and session key. A packet worker is pinned to its own packet by its token. The operator credential may name a thread (`threadId` + `repoPath`) or a packet.
2. **Render.** The desktop lists artifacts for the open orchestrator thread and renders each one inline in the transcript, by creation time, inside a sandboxed iframe. The host mints a per-mount capability token, injects the bridge, and passes the token to the frame in the first message.
3. **Edit.** The frame keeps its own state. Drafts save to the operator's browser only, keyed by artifact id, and never reach the server.
4. **Submit.** The host asks the frame to collect, the frame answers with a payload for one declared action, and the host posts it to the return channel with a fresh nonce and the target it believes it is writing to.
5. **Deliver.** For a packet target the server steers the packet's warm session itself. For a thread target the server accepts the action and the host sends the payload as the operator's own next turn, stamped with the action id. The realtime server marks the action delivered before it persists or runs that turn, and refuses the turn if the stamp does not match an accepted action on that exact thread.
6. **Stale.** When the repository HEAD moves past the origin head (default `pinned` policy), the packet reaches a terminal state, its session changes, or the thread record disappears, the artifact becomes read-only. The card says why. `headPolicy: 'any'` opts out of the HEAD pin.

## Trust boundary

The frame is untrusted. Everything that matters is decided on the server or in the host, never in the document.

| Layer | Mechanism |
|---|---|
| Origin | `sandbox="allow-scripts"` with no `allow-same-origin`, so the frame runs on an opaque origin and holds no o8 cookies or storage. |
| Network | The srcdoc carries a Content Security Policy with `connect-src 'none'`, `form-action 'none'`, `frame-src 'none'`, `child-src 'none'`, `object-src 'none'`, and `base-uri 'none'`. Inline styles and scripts are allowed; external resources are not. |
| Capability | The host validates every frame message through `validateFrameMessage`: it must come from the mounted frame, carry the per-mount token, name a declared action, and stay under the payload and draft size limits. Anything else is dropped. |
| Identity | The submission names its target. The server compares it with the target the artifact was created for and refuses a mismatch before checking anything else. |
| Authorization | Creating needs the operator credential or a packet-bound worker token. Submitting needs the operator credential or an enrolled device. A worker can never submit, so an agent cannot answer its own form. |
| Liveness | The server re-evaluates writability on every submission. Stale artifacts refuse with `read_only`. |
| Contract | The payload is validated against the declared schema. Undeclared keys, wrong types, enum misses, missing required fields, and row overflow are all `schema_violation`. |
| Replay | Every submission carries a nonce. A nonce already accepted for that artifact is refused with `replayed`, enforced by a partial unique index, so a retried request cannot deliver twice. |
| Bounds | HTML 256 KB, payload 32 KB, draft 64 KB, one accepted action per two seconds, and fifty accepted actions before the artifact is suspended. |

Refusals are receipts too. Every rejected submission is persisted with its code and reason, and packet-target artifacts record a `task_artifact_action` lane event for each one.

## Declaring actions

```json
[
  {
    "name": "submit",
    "label": "Send triage",
    "schema": {
      "fields": { "note": { "type": "string", "maxLength": 200 } },
      "rows": {
        "fields": {
          "issue": { "type": "integer", "required": true, "min": 1 },
          "priority": { "type": "string", "required": true, "enum": ["p1", "p2", "p3", "park"] }
        },
        "maxRows": 50
      }
    }
  }
]
```

Field types are `string`, `number`, `integer`, and `boolean`, with optional `required`, `enum`, `maxLength`, `min`, and `max`. `rows` declares a table whose items follow their own field map. The first declared action is the card's Send action. Names are lowercase identifiers, unique within the artifact, at most eight per artifact.

## Frame API

The bridge injects `window.o8` before the agent's document:

| Call | Meaning |
|---|---|
| `o8.onInit(fn)` | Called once with `{ artifactId, title, actions, theme }`. |
| `o8.onState(fn)` | Called whenever writability changes, with `{ writable, reason }`. Disable inputs when it is false. |
| `o8.onCollect(fn)` | The host calls this when the operator presses Send. Return the payload for the card's action, or `null` to cancel. |
| `o8.onResult(fn)` | Called with the server's verdict for a submission: `{ requestId, ok, code?, reason?, actionId? }`. |
| `o8.submit(action, payload)` | Submit from inside the document, for artifacts with their own buttons. |
| `o8.saveDraft(value)` / `o8.getDraft()` | Persist and restore the operator's in-progress edits, locally only. |
| `o8.reportHeight(px)` | Ask the host for a taller card. The bridge also reports size changes on its own. |

Nothing else is available. There is no fetch, no storage, no way to read another artifact, and no way to reach the thread except through a declared action.

## What the session receives

The message delivered to the originating session is a one-line summary followed by the exact payload as fenced JSON:

```
Task artifact "Issue triage" (tart-…) returned action "submit" from the operator (1 field, 2 rows). Receipt tact-….
Exact payload:
```json
{ "note": "first pass", "rows": [ { "issue": 1665, "priority": "p2" }, { "issue": 1875, "priority": "park" } ] }
```
```

The receipt id is the action id. `o8 artifact receipts <id>` and the `o8_task_artifact` MCP tool with `verb: 'receipts'` list every submission and its delivery state.

## Surfaces

| Surface | Verbs |
|---|---|
| HTTP | `POST /api/task-artifacts`, `GET /api/task-artifacts?threadId=&repoPath=` or `?packetId=`, `GET /api/task-artifacts/[id]`, `POST` and `GET /api/task-artifacts/[id]/actions`. All gated by the global middleware. |
| MCP | `o8_task_artifact` with `verb: create | status | receipts` on the operator server. |
| CLI | `o8 artifact create --title … --html <file> --actions <file.json> [--packet <id> | --thread <id> --repo <path>]`, `o8 artifact status <id>`, `o8 artifact receipts <id>`. Inside a packet worktree the worker token pins the target. |
| Desktop | Artifact cards inline in the orchestrator transcript, with a Send button, a sandboxed chip, and a read-only banner when stale. |

## Persistence

Schema v59 adds `task_artifacts` and `task_artifact_actions` to the main database. Actions carry the payload, its SHA-256 hash, the actor, the target snapshot, and the delivery state (`accepted`, `delivered`, `rejected`, `failed`). The partial unique index on `(artifact_id, nonce)` excludes rejected rows, so a rejected nonce may be resubmitted once the cause is fixed, but an accepted one never delivers twice.

## Tests

- `src/lib/task-artifacts/schema-validate.test.ts` covers declaration normalization and payload validation.
- `src/lib/task-artifacts/bridge-protocol.test.ts` covers the hostile-frame gate, the CSP, and the bootstrap surface.
- `tests/task-artifacts-real-path.test.ts` drives the real route handlers against persisted state: worker creation pinned to its packet, cross-target refusal, the exact payload steered once, every refusal as a receipt, the thread delivery mark, HEAD and lane staleness, and survival across a database reopen.
