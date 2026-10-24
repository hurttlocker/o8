# o8d delivery prototype (issue #4395, partial slice)

This standalone Tokio crate is an opt-in experiment. No app launcher, default
port, TypeScript producer, or runtime selection changes. Default Cargo features
build only the delivery library. The binary requires both the `experimental-ws`
Cargo feature and the `--experimental-ws` runtime flag, and refuses non-loopback
listeners. It never executes terminal, orchestrator, or Symon commands.

```sh
cargo test --locked --manifest-path crates/o8d/Cargo.toml --all-features
cargo build --locked --release --manifest-path crates/o8d/Cargo.toml --features experimental-ws
```

For an isolated fixture, provide `WS_TOKEN` and `O8D_SERVER_VERSION` through the
environment, then run the binary with `--experimental-ws --listen 127.0.0.1:0`.
The chosen ephemeral address is the first stdout JSON line. Optional
`--initial-state <file>` supplies a JSON array of TypeScript-produced legacy
initial envelopes. The inherited stdin pipe accepts one JSON array of already
stamped realtime envelopes per line. The crate validates the full batch before
changing its retained state; invalid producer input exits the prototype.
Closing stdin stops it. There is no public HTTP producer route or WS publish
message. Unknown envelope fields survive delivery. Never put credentials in
recordings or initial-state files.

Implemented: shared-token upgrade rejection, connected/welcome
envelopes, version-1 negotiation, known capability audiences, application and
control ping/pong, replacement subscriptions, bounded global retention,
epoch-bound replay, reconnect, and empty-list unsubscription. Private bootstrap
envelopes advance the counter without leaking to replay or live subscribers.
The real-socket Rust test exercises authentication, live publication, reconnect,
replay, and unsubscribe. The URL-based TypeScript parity test runs the identical
control recording against both binaries, including every initial envelope and
the normal close response.

This is **not a replacement for the TypeScript WS server yet**. Remaining work:

* Connect TypeScript's live producers and per-client initial state to this
  inherited-pipe seam; supervise startup, restart, and shutdown behind an app
  opt-in selection flag. No production bridge exists in this slice.
* Bridge fresh bootstrap and replay-gap checkpoint requests to TypeScript. The
  prototype currently behaves like an unavailable checkpoint builder: fresh
  bootstrap yields no events, and a gap yields an empty descriptor. Consequently
  the full `replay.json` and `gap.json` recordings do not pass against Rust.
* Add device credential lookup/revocation and encrypted device handshakes before
  considering remote listeners. Only shared-token loopback fixtures are enabled.
* Implement legacy session/history, packet-tail, terminal, thread, and command
  routing to their existing TypeScript owners. Only empty packet-tail validation
  is included in the control recording.
* Match TypeScript's 64 KiB/32-message/50 ms backpressure policy. The prototype
  uses a bounded Tokio broadcast ring; lag disconnects rather than silently
  claiming equivalent durable delivery.
* Match compression, process-wide heartbeat scheduling, payload limits, RFC
  edge-case close behavior, and graceful `1001` shutdown. Current heartbeats
  start per connection. Shutdown currently drops transports.

The current protocol is documented in
[ws-protocol.md](../../docs/internals/ws-protocol.md). Run the recorded-session
tests with `npx vitest run tests/ws-parity-real-path.test.ts`; they build the
opt-in binary unless `O8D_TEST_BINARY` points to an existing build. They use
isolated data, Git, Next HTTP fixtures, and real WS sockets.

On Linux, run `node --import=tsx scripts/bench/ws-event-bus.ts` with
`O8D_TEST_BINARY` pointing to the release binary. It measures process idle RSS
with zero, one, and twenty connected clients, and time from producer submission
to the last subscriber receipt, with 20
warmups and 200 samples for 1 and 20 clients. Each mutation has a 1 KiB note.
Subscriptions start at the connection's current cursor, excluding retained history.
The TS entry uses its authenticated HTTP producer route; Rust consumes the same
envelope shape through stdin. These are different producer hops, and Rust still
needs TypeScript producers. RSS is per process, not a replacement-system memory
estimate. No real account, desktop app, or model provider is used.

The separate opt-in HTTP transport is documented in [Experimental MCP transport](MCP.md).
