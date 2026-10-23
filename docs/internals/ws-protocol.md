# Current WebSocket delivery protocol

This describes the TypeScript implementation, including its legacy behavior. The
runtime authority is [src/ws-server.ts](../../src/ws-server.ts), especially
`verifyClient`, the connection callback, `handleClientMessage`, `send`,
`sendRaw`, and the realtime log functions. This is a description, not a new
protocol revision. The generated realtime schema is
[generated-contract.ts](../../src/lib/realtime/generated-contract.ts), generated
from [contract.json](../../protocol/realtime/contract.json).

## Connection and authentication

The HTTP server and WebSocket upgrade share the port from `getInstanceIdentity`
and the existing [port resolver](../../src/lib/panel/api-port.ts). The WS path is
`/ws`. Connect with `?token=<credential>`; an Authorization header alone does not
authenticate a WS upgrade. No subprotocol is required. `ws` offers
permessage-deflate with deflate level 1 and a 128-byte threshold. These are
transport settings, not envelope fields. The server does not configure a
custom `maxPayload`; the installed `ws` default applies (100 MiB). HTTP CORS
headers are not an additional WS Origin authentication gate.

Authentication happens before any application message:

1. Constant-time, equal-byte-length comparison with the shared credential accepts
   an operator. [ws-auth.ts](../../src/lib/ws-auth.ts) resolves `WS_TOKEN`, then
   a stored credential, then generates one. Neither a login JSON message nor a
   post-connect token message exists.
2. Otherwise an active enrolled device credential accepts a device subject.
3. A known revoked device credential upgrades only to send close `4401`, reason
   `device revoked`, without registering a client or sending data.
4. Missing, unknown, or failed device lookup credentials fail the upgrade with
   HTTP `401 Unauthorized`. That is an HTTP failure, not a WS `4401` close.

An accepted, non-revoked connection first receives:

```json
{"channel":"system","event":"connected","data":{"clientId":"<opaque>","gateway":"disabled","realtimeSeq":0,"instanceId":"<opaque>","bootId":"<opaque>"}}
```

`realtimeSeq` is the current process-wide counter, not necessarily zero. IDs
identify the client, instance, and boot; clients must not infer host identity
from them. Plaintext clients then receive an `orchestrator-threads/snapshot`
with `{threads:[...]}` and, asynchronously, an `inbox/update` if sync returns
an inbox. Thread snapshot errors are swallowed; inbox absence produces no frame.
Neither is a realtime subscription acknowledgement.

### Device encryption handshake

The **socket peer address**, not forwarded headers, determines loopback status
([loopback-request.ts](../../src/lib/auth/loopback-request.ts)). A remote device
subject gets a plaintext `system/e2ee-hello` after `system/connected`, with data
`{v:1,serverEphPub,serverNonce,serverIdentityPub,serverSig}`. A shared operator
credential and a loopback device connection use the explicit plaintext path.
The client replies with
`{type:"e2ee-init",clientEphPub,clientNonce,clientSig}`. The handler reads these
three fields; it does not validate a `v` field on the init message.

[e2ee-channel.ts](../../src/lib/mobile/e2ee-channel.ts) defines the signed
ephemeral X25519 exchange: Ed25519 signatures bind both nonce/key transcripts;
SHA-512 over the shared key and the ordered public keys derives 32 bytes.
[e2ee-crypto.ts](../../src/lib/mobile/e2ee-crypto.ts) defines the exact transcript
bytes and secretbox framing. On success, the first encrypted plaintext is
`{channel:"system",event:"e2ee-ready"}`. Both directions thereafter use
`{e2ee:1,n:"<base64 nonce>",c:"<base64 secretbox ciphertext>"}`. The nonce is
24 bytes; plaintext is the JSON application envelope. During the 2,500 ms
handshake window application output is suppressed, not buffered for replay.
Initial state is sent after readiness. Malformed JSON is ignored before routing;
bad ciphertext/decrypted JSON is dropped. Plaintext application input during the
handshake or after encryption closes the connection as listed below.

## Client messages, subscriptions, and unsubscription

The dispatcher reads JSON `type`. Unknown types and unparseable JSON receive no
reply. It does not validate every possible JSON value as a record; callers
should send objects. No generic `unsubscribe` message exists.

| Message | Implemented behavior |
| --- | --- |
| `subscribe` or `switch-session`, `sessionKey:string` | Replace the single legacy chat/history session, reset the history cursor, and request immediate history. A missing/non-string key clears it. No ACK. History sync uses limit 18 and then `sinceId`; only nonempty entries yield `history/update`. |
| `realtime-negotiate` | Negotiate version/features as below; separate from credential authentication. |
| `realtime-subscribe`, `subscriptions:[{stream,epoch?,since?,sessionKey?}]` | Replace the **entire** subscription list, then replay/bootstrap each entry. `[]` unsubscribes all realtime streams. No ACK. Duplicate streams remain duplicated. |
| `review-visibility`, `visible:boolean` | Controls review scanning; does not remove durable subscriptions. Reopening schedules repair. |
| `ping` | Reply `{channel:"pong",ts:<Unix milliseconds>}`. No `event` or `data`. |
| `packet-tail-subscribe`, `packetId`, `since?` | Trim the ID, add to the set, send `{channel:"packet-tail:<id>",type:"subscribed",packetId}`, then retained history. Empty ID sends `{channel:"packet-tail",type:"error",error:"packetId is required"}`. |
| `packet-tail-unsubscribe`, `packetId` | Trim and remove the ID, no ACK. |
| `orchestrator-subscribe` / `orchestrator-unsubscribe` | Backend/agent routing plus replay, described below. Unsubscribe has no ACK. |
| `terminal-attach` / `terminal-detach` | Per-terminal membership. Attach can initialize a PTY/snapshot; detach is not a realtime stream unsubscribe. |

Realtime stream normalization accepts `global` and any string starting
`session:`. `session` and `session:*` alias `session:<sessionKey>` only when the
item includes a nonempty `sessionKey`. Other names are skipped. Finite numeric
`since` is accepted as-is, including fractions and negatives. Non-numeric cursors
are treated as absent. A nonempty epoch string is trimmed. There is no stream
permission check beyond connection authentication.

Packet tails use `{channel:"packet-tail:<id>",type:"lane-event",...event}`;
the persisted schema is [packet-tail.ts](../../src/lib/lane/packet-tail.ts).
`since` accepts finite nonnegative numbers or numeric strings and floors them.
History read errors send `{channel:"packet-tail:<id>",type:"error",error}`.
The cursor is Unix milliseconds, not a seq: persisted events must have a
timestamp strictly greater than it. WS history makes one nonblocking read of
at most 200 rows, ordered by timestamp then ID; it does not expose the helper's
optional 500-row maximum, long-poll timeout, or returned `nextSince` on the wire.
There is no WS end-of-history or gap marker for packet tails.

The same dispatcher also accepts terminal creation/input/resize/image/visibility
and benchmark commands, agent kill, orchestrator send/status/interrupt/undo-send,
and Symon tool/text/confirmation/status/stop commands. Those handlers execute
work; they are not event-bus publish messages. Their existing payloads remain
owned by `handleClientMessage` and its named handlers. This slice does not move
those producers into Rust.

## Realtime negotiation

Current supported protocol range is **1–1**, with optional feature
`mobile-inbox-delta-v1`. The client hello has
`{type:"realtime-negotiate",protocol:{min,max},appVersion,clientKind,capabilities,requiredCapabilities?}`.
Min/max must be integers with min <= max; appVersion must trim to nonempty;
clientKind is `desktop`, `mobile`, `web`, or `test`. An absent/non-array capabilities
list becomes empty; unknown requested capabilities are filtered out. An explicit
requiredCapabilities value must be an array containing only known features.

[negotiation.ts](../../src/lib/realtime/negotiation.ts) selects the highest shared
version and filters requested features by introduction version. Success sends
`{channel:"realtime",event:"welcome",data:{protocol:1,serverVersion,epoch,features,legacyFallback}}`.
`legacyFallback` is `{supported:true,protocol:1,removalDate:"2027-08-12",removalProtocol:2}`.
`serverVersion` is the resolved application version, not the protocol version.

Invalid/incompatible hellos send `realtime/incompatible`, data
`{reason,updateRequired:true,supportedProtocol:{min:1,max:1},serverVersion}`.
They do **not** close the socket. An incompatible client cannot recover by
renegotiating on that socket; further subscriptions receive another incompatible
message. A pending client that subscribes without negotiation enters legacy
mode and selects known capabilities from that first subscribe message. Later
legacy subscribe capability lists do not replace the selected set. Successful
explicit negotiation can replace a prior successful selection.

## Envelopes and delivery

There is no universal `{channel,event,data}` schema for all channels. JSON
serialization omits undefined fields. Legacy inbox/history/lifecycle/review,
chat, orchestrator, terminal, thread, and Symon handlers send their own envelopes
through `send`/`sendRaw`; delivery does not add a universal timestamp, ID, or seq.
Packet tails use `type`; application pong has only channel and ts. Unknown
additive payload fields must survive delivery.

Some important legacy shapes from `onChatDelta`, `sendTerminalData`,
`sendTerminalScrollback`, and `sendTerminalResync`:

* `chat/delta` and `chat/done` have data `{text,runId,seq}`; chat seq is nested
  inside data. `chat/error` has `{state,error?,runId}`.
* `terminal/data` has `{sessionName,data:<base64 bytes>}`; retained attach replay
  additionally has `historical:true`.
* `terminal/resync` has `{sessionName,data:<base64 snapshot>,epoch,source,historyTruncated}`,
  where source is `tmux` or `scrollback`. Its numeric visibility epoch is
  independent of the realtime process epoch.
* Orchestrator events have `{channel:"orchestrator",event,data,seq?}`. Live
  broadcasts are stamped; direct subscribe status snapshots are not.

Realtime batches are:

```text
{channel:"realtime",event:"batch",data:{
  delivery:"live"|"replay"|"bootstrap", stream, events:[...],
  epoch, latestSeq, gap?:{requestedSince,earliestAvailable}
}}
```

Each event is
`{protocol:1,seq,stream,channel,event,ts,data,capturedSeq?,snapshot?,delivery?,entityId?,health?,audience?}`.
`ts` is an ISO date string. Seq increments once per constructed envelope across
**all** streams, including private bootstrap events, so stream seqs need not be
contiguous. `capturedSeq` is the checkpoint watermark, distinct from its assigned
seq. Health is `{state:"live"|"warming"|"stale"|"degraded",reason?}`.
The batch latestSeq is its last event's seq, or the current counter for a
gap-only batch. Empty batches are suppressed unless they include a gap.

Current event names/payloads from [types.ts](../../src/lib/realtime/types.ts):

| Event | Data |
| --- | --- |
| `runtime.snapshot` | `{fleet}` |
| `review.snapshot` | `{review,error?}` |
| `browser.snapshot` | `{browserInventory,attachedBrowser?,error?}` |
| `mobile.inbox.snapshot` | `{inbox,revision?}` |
| `mobile.inbox.delta` | `{delta}` (baseRevision/revision and entity changes) |
| `history.snapshot` | `{sessionKey,entries,replace?}` |
| `mutation.record`, `mutation.settled` | `{mutation}` |

Live events are grouped by stream in publication order; every matching
subscription gets a separate batch. The server filters known optional audiences
by selected features. `mobile-inbox-legacy` goes only to clients without the
delta feature; an unknown audience passes through. Bootstrap/resync builders
send their checkpoints directly, rather than applying live audience filtering.
Inbox deltas periodically return to a checkpoint (20 changes, or delta size
at least 80% of snapshot size).

## Replay, reconnect, and checkpoints

`REALTIME_EPOCH` is a random process-lifetime ID. The retained log is in memory,
shared across streams, with `max(4,parseInt(O8_REALTIME_LOG_LIMIT)||400)` entries.
Events explicitly marked `delivery:"bootstrap"` increment seq but are not logged.
Normal resync events are logged. No age limit or persisted restart replay exists.

For each replacement subscription, `replayRealtimeSubscriptions` installs the
list before it checks the cursor:

* With a cursor, a different/missing epoch, cursor > global counter, or a positive
  cursor earlier than `earliestRetainedSeq(stream)-1` forces a checkpoint. A
  positive cursor also forces one when that stream has no retained events.
* Gap output has batch delivery `bootstrap`, authoritative snapshot events, and
  `{requestedSince,earliestAvailable}`. When nothing is retained,
  earliestAvailable is the then-current global counter + 1. A checkpoint fetch
  failure still emits an empty, gap-bearing batch.
* Otherwise retained matching events with seq > since are sent as `replay`.
  No matching entries means no replay frame.
* **Absent** since behaves like zero for replay, then schedules an additional
  bootstrap. Explicit since zero does not schedule that extra bootstrap. A
  numeric cursor without its epoch forces a checkpoint, even when zero.

Global checkpoints contain runtime/review/browser and, if available, registered
mobile inbox state. Session checkpoints fetch at most 200 history entries and
replace the transcript. Fresh bootstrap envelopes carry `delivery:"bootstrap"`;
gap resync envelopes have degraded health but do not carry that inner delivery
field. Snapshot reads are asynchronous; live batches can arrive while a
checkpoint is being built. Replacing/unsubscribing does not cancel an already
scheduled snapshot promise. Clients use the captured watermark and seqs when
applying the result. Reconnect creates a new client: negotiate and resubscribe
with the last **epoch and seq**; there is no automatic membership restoration.

Orchestrator replay is a separate protocol:
[replay-buffer.ts](../../src/lib/orchestrator/replay-buffer.ts) keeps 1,500 events
per session, seq starts from current Unix milliseconds and increments. `busy`
clears retained entries before recording; `ready`, `dead`, or `error` clears
after recording. Only finite numeric `since` on `orchestrator-subscribe` opts
in to replay; <= 0 requests the whole in-flight turn. Subscribe sends a status
snapshot first (including server turn truth), then seq replay, then a latest
plan snapshot if still busy. Completed turns recover from persisted history.
`handleOrchestratorUnsubscribe` removes a specific backend/agent subscription;
backend alone removes all that client's subscriptions for that backend. A
missing or unrecognized backend removes all that client's orchestrator subscriptions.

Terminal replay uses a separate bounded byte history, not realtime cursors.
`TERMINAL_SCROLLBACK_MAX_BYTES` retains at most 512 KiB of whole chunks per
attachment, discarding oldest chunks. Hidden clients retain at most 64 KiB of
newest bytes in
[terminal-hidden-buffer.ts](../../src/lib/ws-server/terminal-hidden-buffer.ts);
overflow marks the view for resync. A tmux snapshot requests 3,000 scrollback
lines (from [client-retention.ts](../../src/lib/terminal/client-retention.ts))
with an 8 MiB capture output ceiling. Visibility recovery either sends a tmux
snapshot or retained scrollback; failures/truncation add diagnostic markers and
set `historyTruncated`. This does not promise a replay of all terminal output
since disconnect. `terminal-detach` removes that client's terminal membership;
subsequent PTY lifetime follows the existing transient/dashboard/session policy.

## Backpressure, heartbeat, and closes

[channels.ts](../../src/lib/ws-server/channels.ts) sets a 64 KiB socket-buffer
threshold, 32 queued durable messages per client, and a 50 ms drain interval.
Above the threshold, pong, chat/delta, terminal/data, and orchestrator/output
are lossy. Other envelopes queue; overflow drops the oldest. This is bounded
best-effort delivery, not disk durability. Drain preserves queued order before
sending a new frame. Encrypted clients are classified using plaintext channel
fields, then queued as encrypted frames.

Every 25 seconds, a separate RFC WebSocket ping checks liveness. Receiving a
control pong sets alive=true; JSON `{type:"ping"}` does not. At the next tick a
client still marked dead is terminated without a close handshake. Clients
usually observe `1006`. The device revocation sweep runs every 20 seconds.

| Code | Reason/trigger |
| --- | --- |
| `4401` | `device revoked`; or defensive `missing authenticated subject` |
| `4403` | `e2ee handshake required` on timeout/init failure or premature plaintext input; `e2ee handshake failed` on bad init; `encrypted frames required` on plaintext after readiness |
| `1001` | `server shutting down` on SIGINT/SIGTERM cleanup |
| `1006` (observed, never sent) | Abnormal transport loss, including missed control pong termination |

Other RFC close codes, including oversized-message `1009` and framing errors,
come from `ws`. A valid peer close is answered by the library. Negotiation
failure and durable queue overflow do not themselves close the socket.

## Parity recordings

Run a trusted recording against any compatible server URL:

```sh
node --import=tsx scripts/ws-parity.ts --url="$O8_WS_PARITY_URL" \
  --recording=tests/fixtures/ws-parity/control.json
```

Supply the credential in `O8_WS_PARITY_TOKEN`, never in the recording. The
fixture recordings use an isolated, empty data store and the Next HTTP fixture
in [ws-parity-server.ts](../../tests/fixtures/ws-parity-server.ts). Replay also
needs `--fixture-url` for fixture history changes. These recordings are not
intended for a real account or a production server.

[ws-parity-session.ts](../../scripts/lib/ws-parity-session.ts) consumes every
delivered envelope in order per socket, including unsolicited initial state,
and compares exact object keys, array order, control ping/pong, HTTP upgrade
rejections, and close code/reason. No channels are dropped. Explicit scalar
`{$capture:"name",type:"string"|"number"|"boolean"}` fields bind opaque IDs,
timestamps, or initial seq; repeated captures require equality. `{$ref:"name"}`
reuses bindings in inputs and expectations; numeric refs support `add`. These
are the only substitutions. Missing/extra/reordered envelopes and unclosed
clients fail. Record an expected close explicitly after the close action. A
delay action bounds observation of unsubscribe silence; a final 100 ms drain
also catches trailing messages. Finite recordings cannot prove perpetual silence.

The integration test launches `src/ws-server.ts` with the same server-only stub
and fixture Next boundary as the existing negotiation real-path test. The
recording runner is URL-based; it does not import the server's replay helpers.
Its fault cases deliberately change fields, order, counts, and closes so a
green comparison also demonstrates that mismatches are detected.
