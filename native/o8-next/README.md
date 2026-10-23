# o8 next: saved transcript slice

Opt-in Rust GPUI surface for #4405. Lists saved orchestrator sessions and reads a
selected session's latest 100 messages. Operator/agent prose, headings, lists,
inline styles, code fences and contiguous tool-step groups render natively.
Refresh reads another snapshot. Home/End and ordinary wheel scrolling work;
scrollbar tracks are hidden. The first slice uses the midnight palette.

This PR takes the issue's static-history fallback. It does **not** complete #4405.
WebSocket streaming, retaining completed-turn layouts during live updates,
provider-session performance acceptance, pagination beyond the server's 100-entry
history tail, runtime worker discovery and full rich-event parity remain open.
Media, packet headers, handoffs, compaction/command receipts, tables, HTML,
diagrams, diff cards and visualization cards are outside the tested parity set.
Unsupported event details get a notice; unsupported Markdown stays readable as
text/code. Links are read-only labels. There is no composer or mutating action.

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
| Deferred live history | `src/lib/transcripts/wireWsBridge.ts`, `src/ws-server.ts`: `realtime-subscribe` for `session:<sessionKey>`, realtime batches containing `history.snapshot` with `{sessionKey,entries,replace}` |

The future live slice must also handle incremental runtime/chat events, replacement
snapshots, reconnect ordering, and changes to existing tool ids. A new protocol or
append-only assumption would lose corrections. This slice has no WebSocket client.

## Verification

```sh
cargo +1.97.1 test --manifest-path native/o8-next/Cargo.toml --release --locked
npx vitest run tests/next-render-parity.test.ts
node cli/esbuild.config.mjs
O8_NEXT_BINARY="$PWD/native/o8-next/target/release/o8-next" node --import ./scripts/register-server-only-stub.mjs --import tsx scripts/next/verify.ts
node scripts/next/license-audit.mjs
```

The three recordings were captured through the production history route from
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
asserts that every server request used one of the two existing GET routes.
`--record` explicitly regenerates recordings and trees; ordinary verification
compares them without updating expected output. UTC fixes timestamp labels.

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
and the first content scene. Memory is RSS of this binary only. Raw runs and
limits are in `evidence/metrics.md`.

Needs an unattended on-screen run: compositor frame cadence and content capture.
GPU latency and compact/wide visual acceptance also remain unverified; this helper
does not automate those checks. The single script
`scripts/next/unattended-on-screen.swift` launches the explicit experiment binary
with a seven-second lifetime and in-process navigation, then captures only that
child PID's exact `o8 next` window for five seconds. It never sends OS input or
activates windows. Compile it with `swiftc -parse-as-library` and pass the binary,
the disposable server origin, and an output JSONL path. It was typechecked but
**not executed**. Captured complete frames still do not establish photon timing.
