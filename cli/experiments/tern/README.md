# Read-only Tern lab: S2 of o8 #3365

Status: downstream experiment, not an installed `o8 lab tern` subcommand.
This deliberately uses a separate entry point until the Pi/OMP coexistence proof
is complete. No root dependency, runtime ID, migration, dispatch, approval, merge,
worker stdin attachment, or persistent-daemon implementation is added.

## Run

From the repository root, install only this experiment's public SDK and compiler:

```sh
npm --prefix cli/experiments/tern install --ignore-scripts
npm --prefix cli/experiments/tern run build
node cli/experiments/tern/demo.mjs --fixture
node cli/experiments/tern/demo.mjs --packet packet-123
node cli/experiments/tern/demo.mjs --packet packet-123 --text
node cli/experiments/tern/demo.mjs --packet packet-123 --json
```

Live mode requires the existing `o8` executable on PATH and its normal connection
configuration. It invokes only `o8 packet info [id] --json`, without a shell, with
bounded output and timeout. Without `--packet`, the existing command resolves the
current worktree. Authentication, read errors and drift warnings are preserved;
there is no substitution of fixture data after a live error.

`--fixture` is explicitly synthetic, never a claim about a live worker. `--json`
is machine-readable with no probe. `--text`, `TERN_TSP=0`, piped stdin/stdout,
raw input already owned by another UI, or a tmux/screen/zellij environment keep
plain output. Missing SDK installation also keeps plain output after the shared
TypeScript model has been built. No Tern beta binary is required.

## Ownership and reuse

The data source is the existing packet-info envelope. Its facts go through
`buildPacketInfoSurface` from S1. The pure formatter is shared with S1's ordinary
human renderer; its heading callback preserves existing TTY color behavior.
No server module or `ws` dependency is imported into the experiment.

The optional `@stencil-hq/tern@0.1.0` SDK owns negotiation, framing, raw-mode
ownership and cleanup. This code does not carry its own APC/TSP implementation.
After a real hello, the adapter requires `flow` and every node kind it uses.
A static `flow` surface with `listen:false` publishes one frame, keeps the output
on close, and installs no action handlers. There is no render loop or worker
lifecycle callback. Text is emitted only after SDK cleanup has been attempted.
On a broken transport, native removal is best effort; a truly broken stdout
still returns an error rather than a false success.

## Evidence and gates

```sh
npm --prefix cli/experiments/tern test
TERN_REQUIRE_SDK=1 npm --prefix cli/experiments/tern test
```

`test.mjs` covers exact legacy plain-text parity, truthful unknowns, pure native
projection, optional-SDK behavior, capability checks, tty/cleanup ordering,
read-only delegation, command errors, JSON mode and malformed envelopes.

`sdk.test.mjs` uses the actual public SDK against an independent fake terminal:
hello plus DA1, fragmented replies, missing/malformed hello, native-disabled,
capability mismatch, frame-write loss, cleanup and semantic equivalence. A
separate SDK-level test drives 1,000 updates under one credit and checks newest-
view coalescing. That test prepares a future live surface; the current static
`listen:false` demo does not require ACKs and does not claim a live-stream test.

CI sets `TERN_REQUIRE_SDK=1`, so a missing SDK is a failure, never silently green
through skipped protocol cases. The root install and ordinary CLI remain
independent of this package. Compiler and SDK versions are pinned, and CI
installs from the committed lockfile with `npm ci`.

Initial local receipt: Node 22.16.0, TypeScript 5.8.3 (global compiler), 29 adapter/
command tests passed, 11 real-SDK checks explicitly skipped because this sandbox
cannot download the SDK. The test-first text-only baseline had 21 passing and
8 failing feature cases; implementation reached 29/29. This is a new-feature RED,
not a reproduced upstream defect. The dedicated workflow installs TypeScript
5.8.2 and the real SDK; its status must be checked separately. Neither these
fixtures nor unit tests establish visual quality or daemon persistence.

## Next gate: Pi/OMP coexistence before product integration

- Pin exact o8, Pi/OMP, SDK and Tern beta versions/capabilities.
- Trace the current Pi RPC/permission bridge and process supervisor; do not
  assume the OMP TSP frontend is the same execution path as o8's Pi adapter.
- Prove one stdin/PTY owner; no direct terminal path around o8 permission checks.
- Prove complete normalized transcript/lifecycle evidence with native output.
- Verify current resume/steer/interrupt behavior, including terminal loss.
- Distinguish pane detach, process exit and authoritative packet settlement.
- Test re-association after restart without using pane ID as provider/packet ID.
- Obtain actual native captures and versioned beta receipts before claiming E2E.

No approval, merge, dispatch or persistent-session backend is part of S2.

## Provenance

Authority boundary, build order and acceptance criteria:
https://github.com/hurttlocker/o8/issues/3365

The TSP protocol and SDK are maintained upstream:
https://github.com/stencil-hq/tern-sdk
https://docs.stencil.so/tern/protocol/handshake.html
https://docs.stencil.so/tern/protocol/surfaces.html
