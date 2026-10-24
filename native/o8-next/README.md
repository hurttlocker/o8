# o8 next: live saved transcripts

Opt-in Rust GPUI surface for #4405, stacked on the static history slice in #4410.
Lists saved orchestrator sessions, bootstraps the selected session's latest 100
messages over HTTP, then subscribes to its existing WebSocket history stream.
Operator/agent prose, lists, inline styles, code fences and tool-step groups are
read-only. Home/End and wheel scrolling work; scrollbar tracks are hidden.

Unchanged rows retain their shaped text, wrapping and measured height across tail
updates and scrolling. Only changed content or a viewport-width change computes a
new row layout. GPUI still positions list items and paints the scene. Replacement
snapshots and late tool results can invalidate the affected row. Refresh and
session selection cancel the previous subscription and load a new history.

This slice does **not** complete #4405. Disposable provider-session acceptance,
older-history pagination, runtime-worker discovery and full rich-event parity
remain open. The tested surface covers text/code/tool history, not media, packet
headers, handoffs, compaction receipts, tables, diagrams, diff or visualization
cards. Unsupported content remains labeled or readable as text/code. There is no
composer or session mutation.

## Build and use

macOS is the verified target for this slice. From the repository root, with the
normal JavaScript dependencies installed:

```sh
cargo +1.97.1 build --manifest-path native/o8-next/Cargo.toml --release --locked
node cli/esbuild.config.mjs
node --import ./scripts/register-server-only-stub.mjs --import tsx scripts/next/dev-server.ts
```

The last command prints a newly allocated loopback origin and exits after two
minutes. It owns a temporary data directory, database and fixture Git repository.
It hosts the real production GET handlers without application startup hooks,
runtime discovery or provider calls. In another shell, substitute that exact
origin for `ORIGIN`:

```sh
node cli/dist/o8.mjs next --enable-next --binary "$PWD/native/o8-next/target/release/o8-next" --server ORIGIN
```

The normal window is created without activation. Automated verification always
adds `--offscreen`, which uses `Application::headless()` and a hidden window.
Do not run visible checks at an occupied desk. The shipped Tauri binary, its
startup/defaults, and its data directory are not part of this feature.

The launcher requires both the opt-in flag and an explicit absolute executable
path. The native client requires an explicit numeric loopback HTTP origin with a
port; it does not discover installed configuration, read app data files, follow
redirects, use environment proxies, acquire tokens, or send requests that mutate
sessions. Responses are bounded to 16 MiB and requests time out after five seconds.

## Existing contracts

No server route, response shape or authentication policy changes.

| Purpose | Existing source and contract |
| --- | --- |
| Saved session list | `src/app/api/mobile/orchestrator/threads/route.ts`: GET, `limit=500`, `{threads}`; thread id is used unchanged |
| History used by web transcript store | `src/lib/transcripts/bootstrap.ts`, `src/app/api/mobile/history/route.ts`: GET with `sessionKey=llm-chat:<thread id>&limit=100`, `{sessionKey,transcript}` |
| Transcript fields | `src/lib/mobile/types.ts`: `MobileHistoryResponse`, `MobileTranscriptEntry`, `MobileTranscriptToolCall` |
| Web presentation | `WorkspaceTranscript.tsx` -> `workerTranscriptBlocks`, `groupActivitySteps`, `WorkerProse` -> `sanitizeTranscriptText`, `renderLLMMarkdown` |
| Live session history | `src/lib/transcripts/wireWsBridge.ts`, `src/ws-server.ts`: `realtime-subscribe` for `session:<sessionKey>`, realtime batches containing `history.snapshot` with `{sessionKey,entries,replace}` |

The native client gets port/token from the existing `/api/panel/ws-info` route,
then connects directly to the same numeric loopback host at `/ws?token=...`.
It sends `realtime-subscribe` with the selected `session:<sessionKey>` only;
it does not subscribe to unrelated global/provider inventories. It follows the
desktop provider's sequence, captured-sequence and boot-id rules. Reconnect uses
bounded backoff and omits `since` to request a fresh checkpoint. The selected
session ignores other streams and other session payloads.

`replace: true` replaces the retained window, including an empty window. Other
updates use the dashboard's `mergeTranscriptEntries` semantics, preserving
optimistic local entries and supported metadata while allowing old server history
to disappear. Retention is capped at the web store's 200 entries. The client never
assumes that updates append or that completed tool results are immutable.

## Verification

```sh
cargo +1.97.1 test --manifest-path native/o8-next/Cargo.toml --release --locked
npx vitest run tests/next-render-parity.test.ts tests/next-stream-parity.test.ts
node cli/esbuild.config.mjs
O8_NEXT_BINARY="$PWD/native/o8-next/target/release/o8-next" node --import ./scripts/register-server-only-stub.mjs --import tsx scripts/next/verify.ts
node scripts/next/license-audit.mjs
O8_NEXT_BINARY="$PWD/native/o8-next/target/release/o8-next" O8_NEXT_STREAM_RESULTS=native/o8-next/evidence/stream node --import ./scripts/register-server-only-stub.mjs --import tsx scripts/next/verify.ts
```

The original three history recordings were captured through the production history route from
**authored disposable persisted sessions**, not private operator histories or live
provider runs. The long recording proves the existing 120-to-100 tail behavior.
The web oracle inspects the actual production React elements and tool grouping;
it is not another Markdown parser. The Rust renderer and its `--render-tree`
entry point consume the same typed model and expected trees. Five web checks
cover parity plus deliberate order/code/group mutations. Rust checks compare all
three trees and reject ambiguous or remote server origins.

The protocol runner starts and reaps its own server, compares fresh HTTP responses
with recordings and native trees, then runs the built CLI -> native asynchronous
session list -> history -> GPUI paint path. It verifies that an inherited database
path was never opened, rejects invalid native invocations before UI startup, and
asserts that every request used the existing list/history/ws-info GETs or the
read-only WebSocket subscription/ping messages. The host always generates a fresh
fixture credential, even if a token was inherited. The WS replay peer uses the
production wire schema; it does not import the large server startup module or
start runtime/provider discovery. This is protocol interoperability with a replay
peer, not a live provider run.
`--record` explicitly regenerates recordings and trees; ordinary verification
compares them without updating expected output. UTC fixes timestamp labels.

The live replay oracle runs the **actual desktop WebSocket provider** with the
dashboard's configured merger and production transcript renderer. Rust offline
replay and three native network runs must reach the same final structured tree.
Recordings include stale/late events, a real transport reconnect with checkpoint,
empty replacement, boot restart, wrong-session data, and an advancing partial
history window. Five additional production-merger cases cover optimistic entries,
metadata, argument order and duplicate-id ordering.

The retention probe checks unchanged row-state identity and monotonic layout
counters. A deliberately broken binary that recreated rows failed this assertion;
the retained implementation passes. See [stream receipts](evidence/stream/README.md).
The original static-only receipts remain in `evidence/verification.md`.

The preview-only tool case initially failed with native groups `[0,1,1,2]` versus
the web's `[0,0,0,1]`. Keeping absent command arguments distinct from empty string
arguments fixed the failure. See `evidence/verification.md` for final receipts.

UI imports come exclusively from `gpui = 0.2.2` (Apache-2.0). The locked normal/build
graph audit rejects GPL licenses and the excluded editor, terminal and markdown
application crates. Transitive dependencies include other permissive and MPL-2.0
licenses; the whole graph is not described as Apache-only.

Published GPUI pins Taffy exactly 0.9.0. A documented MIT-licensed
[manifest-only Taffy backport](vendor/README.md) selects patched Grid 1.0.1;
Taffy's published Rust source is unchanged. No security checks are suppressed.

## Measurements and unattended work

`--offscreen --benchmark FILE` runs the actual asynchronous session-loading path,
then acknowledges 20 Home/End keystrokes and 50 alternating scrolls inside GPUI.
Each keystroke must reach the scene's paint callback, and the first and last
content rows must reach their own paint callbacks. The scroll timer includes
the first draw after changing the visible range. Cold start includes HTTP loading
and the first content scene. Memory is RSS of this binary only. The base static run receipts and limits are in `evidence/metrics.md`; current
streaming results are in `evidence/stream/README.md`.

Needs an unattended on-screen run: compositor frame cadence and content capture.
GPU latency and compact/wide visual acceptance also remain unverified; this helper
does not automate those checks. The single script
`scripts/next/unattended-on-screen.swift` launches the explicit experiment binary
with a seven-second lifetime and in-process navigation, then captures only that
child PID's exact `o8 next` window for five seconds. It never sends OS input or
activates windows. Compile it with `swiftc -parse-as-library` and pass the binary,
the disposable server origin, and an output JSONL path. It was typechecked but
**not executed**. Captured complete frames still do not establish photon timing.
