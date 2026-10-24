# o8 next: live sessions and composer

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
cards. Unsupported content remains labeled or readable as text/code. The composer
and queue actions are described below.

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
redirects or use environment proxies. The composer requires an explicit HTTP
operator bearer in `O8_NEXT_API_TOKEN`; queue POST/PATCH are its only mutations.
Responses are bounded to 16 MiB and requests time out after five seconds.

## Existing contracts

No server route, response shape or authentication policy changes.

| Purpose | Existing source and contract |
| --- | --- |
| Saved session list | `src/app/api/mobile/orchestrator/threads/route.ts`: GET, `limit=500`, `{threads}`; thread id is used unchanged |
| Sidebar packet attention | `src/app/api/orchestrator/state/route.ts`: GET; join packets by `orchestratorThreadId` |
| Saved composer context | `src/app/api/v2/chat-history/route.ts`: GET with `tabId`, `limit=100` |
| Operator queue | `src/app/api/orchestrator/composer-queue/route.ts`: GET items/capabilities, POST frozen payload/id, PATCH existing id to steer |
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

For three macOS release composer runs against fresh disposable fixture hosts:

```sh
cargo +1.97.1 build --manifest-path native/o8-next/Cargo.toml --release --locked
O8_NEXT_BINARY="$PWD/native/o8-next/target/release/o8-next" node --import ./scripts/register-server-only-stub.mjs --import tsx scripts/next/macos-composer.ts
```

The runner always passes `--offscreen`, checks that the window stays inactive,
and limits each child to nine seconds. It records CPU scene acknowledgement,
not GPU presentation or physical input latency. See [macOS composer evidence](evidence/macos-composer.md).

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

## Sidebar and composer (#4462)

The composer uses the existing durable queue API. Steer is the default when the
server advertises `canSteer`; otherwise it sends next. The mode control (or
Ctrl+Shift+Enter) selects Send next explicitly. Queued records expose Steer now
only for their server-advertised capability and before admission. F6 promotes
the first eligible record. Enter sends, Shift+Enter adds a line, and Tab switches
between composer and sidebar keyboard navigation. IME confirmation never sends.
Paste preserves line breaks; Unicode selection, copy/cut, undo/redo and scrolling
through long input use GPUI's platform text-input contract.

This slice sends text in Solo mode using the saved backend/model and latest
assistant permission receipt (workspace Full when absent; never inherits an
outside-workspace grant). Effort is Medium. The routing is shown before sending.
Drafts and undo stacks are retained per session in memory. An unconfirmed send
keeps its draft, identity and routing for retry during this process; it is not a
cross-launch draft store. Confirmed operator echoes come from persisted history.
Legacy history remains readable when its routing is insufficient for sending.

Sidebar sessions poll the existing session and mission APIs once per second and
use Working, Review and Recent groups. Review sorts attention before recency;
other groups sort by last message. Queue reconciliation preserves the live
transcript and its retained row layouts.

Set `O8_NEXT_API_TOKEN` to the selected server's operator bearer through the
environment. The native process sends it only to that numeric loopback HTTP
origin, without redirects or proxies; it never logs the token or discovers
application files. The fixture host and client share an explicit environment
credential and cross production middleware.

On Linux without a display, run `verify.ts --protocol-only` plus
`cargo test --locked --manifest-path native/o8-next/Cargo.toml`. Composer tests use
GPUI TestAppContext, production HTTP handlers and persisted queue/history,
replacing only native runtime admission with a fixture acknowledgement. See
[sidebar/composer evidence](evidence/sidebar-composer.md).

## Pane grid (#4530)

The independent grid root is opt-in. The normal single-session surface and the
shipped Tauri app keep their existing behavior. The dedicated disposable fixture
host reuses the `dev-server.ts` pattern and prints an `origin` and a `workspace`:

```sh
node --import ./scripts/register-server-only-stub.mjs --import tsx scripts/next/grid-dev-server.ts
node cli/dist/o8.mjs next --enable-next --binary "$PWD/native/o8-next/target/release/o8-next" --server ORIGIN --pane-grid 6 --workspace WORKSPACE --pane-layout "$PWD/work/pane-layout.json"
```

Create the `work` directory first. Use the printed origin and workspace values,
and provide the selected server's operator bearer through `O8_NEXT_API_TOKEN`,
as for the existing composer. No installed configuration or data path is read.
The fixture host supports the existing protocol-only checks without a desktop.
The grid window itself still needs a platform display; on Linux without one,
use the headless tests below.

The size choices are 1, 2, 4 and 6. Ctrl+Alt+arrow moves focus geometrically;
adding Shift moves the pane and its focus together. Tab/Shift+Tab cycles focus.
Home/End scrolls the focused transcript. Ctrl+Alt+W closes its viewer, leaving
the worker running. Ctrl+Alt+P cycles through sessions not already in a slot;
Ctrl+Alt+1/2/4/6 changes size. Ctrl+Alt+Enter zooms the focused pane. The toolbar
also exposes size, session selection, zoom and refresh; headers expose Close.

The explicit layout file stores size, ordered session keys and focus separately
for each exact workspace path. A saved workspace layout takes precedence over
the initial command-line size. Smaller grids retain their hidden slots, live
streams and scroll positions. Closed viewers drop their subscription. Missing
sessions retain their slot and show “unavailable”; refreshing retries discovery.
Invalid layout files are rejected before window startup and preserved.

Saved threads and runtime workers come from the existing thread and inventory
GETs. Original worker keys select the existing history GET and session stream;
there are no new server routes. Each slot uses the existing native transcript
merger and retained row renderer. Headers contain at most 40 Unicode scalar
values of title and static state words from session status/outcome fields.
Hidden slots do not enter the element tree. Clip gates defer both header and
transcript layout until visible, before any text shaping or painting.

```sh
cargo test --locked --manifest-path native/o8-next/Cargo.toml
npx vitest run tests/next-pane-grid-real-path.test.ts tests/next-render-parity.test.ts tests/next-stream-parity.test.ts
cargo test --release --locked --manifest-path native/o8-next/Cargo.toml pane_grid_measurement -- --ignored --nocapture
```

The grid currently contains read-only transcript panes. Per-slot terminals
remain to be integrated with the separately reviewed terminal surface; this
change does not import that branch. Measurement endpoints, raw samples and
remaining acceptance are in [pane grid evidence](evidence/pane-grid/README.md).
