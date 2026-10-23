# Speed baseline — #2887

Measured 2026-10-23 from `d283e620b72fc0f774c8c1db9e1ee2f66fb5ccea`
(0.1.805). This is an observation baseline and a ranked experiment queue. No
application implementation was ported, and no CI budget is enabled.

## Method and limits

Hardware: 8-core/16-thread Intel desktop, 64 GiB RAM, APFS SSD, macOS 26.6.
Node 22.23.2; optimized local Next 16.3.8 build; TypeScript-source WS server for
the web lane. Native uses a separately identified Tauri custom-protocol **debug**
build with the development observation plugin and optional speech helpers
excluded. These are development artifacts, not installed-release timings.

Every active instance uses disposable data, repositories, sockets, ports and
provider session state inside this worktree. The installed application was only
observed with process/allocation tools; it was never stopped or reconfigured.
Dependencies were already present. No package installation was run.

Each startup and worker population has three launches. MCP has 30 interleaved
warm requests per operation, with the first call recorded separately. UI has
three browser launches, each with three alternating repetitions of each arm.
Each memory population has three independent instances, each observed for at
least an hour. Processes start cold; filesystem and dependency caches are warm.

The hour-long cohorts overlap. The installed app, other development work,
compilation and component-calibration cleanup also contended for this host.
Consequently these numbers establish reproducible instruments and bottleneck
candidates, **not quiet-host release budgets or predicted speedups**. Do not pool
different populations or sum overlapping stage medians. Repeat on a quiet host
before setting the #2887 CI ratchet.

The UI stress fixture has 300 bounded markdown/code entries per session and a
20 Hz last-entry update. The soak uses a 1 Hz update, periodic status/task calls
and unsent draft edits in the web lane. Native persists bounded provider JSONL
and refreshes it through the real owned-log parser, HTTP history endpoint, WS
bridge and WebKit renderer; per-minute receipts verify advancing transcript
ticks. It is a normal-cadence simulation, not a replay of private operator data
or an unbounded multi-day workload. The history bridge limits each snapshot to
200 entries. Synthetic completed records claim no live provider process.

Milliseconds below use the median and worst observation; p95 uses nearest rank.
Missing token observations are unavailable, never zero. Raw heaps, provider
logs, credentials and allocation stacks remain private. The accompanying
[numeric receipt](speed-baseline.json) omits paths, arguments, transcripts and
machine identities. Harness instructions: [scripts/speed](../../scripts/speed/README.md).

## Startup

Sequential native launches, closing each owned instance before the next:

| Stopwatch | n | Median ms | Worst ms |
| --- | ---: | ---: | ---: |
| Native launch → loader first-contentful-paint | 3 | 35,687 | 37,527 |
| Native launch → accepted composer input | 3 | 70,526.89 | 75,897.48 |
| Native launch → Next healthy response | 3 | 59,035.76 | 62,930.82 |
| Native launch → WS healthy response | 3 | 51,275.58 | 53,813.51 |
| Context initialization, within native startup | 3 | 32,425 | 34,182 |

The overlapping startup population was slower: FCP 66,046 / 69,183 ms and
interactive 127,595.10 / 135,190.58 ms. It is supplementary and not pooled with
the sequential population. Both still share the host with the ongoing soak.

Separate browser/source-server launches:

| Stopwatch | n | Median ms | Worst ms |
| --- | ---: | ---: | ---: |
| Next process launch → fully read healthy response | 3 | 12,184.43 | 15,817.51 |
| WS process launch → fully read healthy response | 3 | 13,651.63 | 18,855.28 |
| Browser navigation → first paint | 3 | 1,640 | 2,308 |
| Browser navigation → hydrated, editable composer | 3 | 11,504.73 | 15,543.26 |

Native FCP is WebKit Paint Timing from the generated loader, delivered to a
private loopback measurement listener. It is not an OS compositor timestamp.
Native interactive accepts an unsent input through the normal composer; the
IPC/polling/two-frame acknowledgement is an upper bound. Healthy-response probes
run concurrently from launch. Browser paints use Chromium Paint Timing after
waiting for entries to register.

Dominant native startup candidate: context/ACL initialization before the window
can be created. Allocation stacks below identify compiled regexes there. This
is already Rust; the experiment is to share compiled matchers, not rewrite JS.
Source-server bootstrap is architecture-bound (process/module initialization);
the WS result includes the TypeScript loader. This does not establish the boot
cost of the installed, bundled WS server.

## Workers

Real primary mission dispatches use pinned `gpt-6.1-sol` or `claude-sonnet-5`,
medium effort, and an immediate-reply task. Each returned packet was stopped
successfully. Stopwatch zero is dispatch of an already prepared mission.

| Stage, ms median / worst | Codex (n=3) | Claude Code (n=3) |
| --- | ---: | ---: |
| Dispatch → lane admitted | 688 / 1,103 | 645 / 872 |
| Admitted → persisted worktree binding | 35,654 / 39,432 | 23,785 / 26,994 |
| Binding → worker process spawned | 1,293 / 1,747 | 1,124 / 1,200 |
| Dispatch → spawned | 37,635 / 41,866 | 25,444 / 28,839 |
| Dispatch → first stdout bytes | 40,195 / 44,584 | 29,110 / 32,031 |
| Spawn → first assistant output | 10,655 / 12,278 | 4,992 / 5,118 |
| Dispatch → first assistant output | 49,913 / 52,521 | 30,562 / 33,831 |
| Clone, within preparation | 635 / 671 | 524 / 573 |
| Checkout, within preparation | 530 / 1,738 | 375 / 512 |
| Asset hydration, within preparation | 896 / 1,858 | 445 / 618 |

Admission and preparation come from persisted lane events. A Node child-spawn
event is matched to the persisted runtime PID. Stdout is observed every 50 ms.
Claude exposes token deltas. Codex exposes a completed assistant message in this
carrier: its **model first-token latency is unavailable**; 10.66 seconds is an
upper bound, including CLI initialization and provider/network time, not a
separated model-service measurement.

The fixture has a local Git origin and requires no dependency installation.
Thus dependency-install time is **not exercised**. It cannot validate a large
real-repository 2–3 minute report. A separate production-helper calibration
cloned this worktree's real dependency tree three times using verified APFS
clones: **28,501.05 ms median, 31,953.07 ms worst**. No package manager ran, and
only those receipted copies were removed. Clone cleanup is outside the timing.

A separate full-workflow/contention population includes mission creation:
Codex creation/preflight 2,557.69 / 8,484.25 ms, request-to-output 73,646 /
75,578 ms; Claude creation/preflight 5,207.93 / 7,855 ms, request-to-output
69,739 / 72,711 ms (three each). Both provider lanes ran concurrently. These
are supplementary observations, not pooled with primary prepared dispatch.

The dominant primary worker interval is architecture-bound preparation, rather
than the tiny clone itself. The interval contains many subprocesses, guards and
background inventory checks. Process counts are observations within the
interval, not causal attribution to that packet. A controlled production-helper
comparison (three rounds × 20 alternating calls) measured direct Git status at
56.92 ms median / 80.94 worst versus guarded status at 540.48 / 1,473.54:
**483.56 ms median added per guarded call** under this host load. Preserve all
ownership/storage checks when testing batching or a Rust helper. Dependency
materialization and Git/network work are I/O-bound; a language port alone does
not remove them. Provider output is an I/O/carrier interval until separately
instrumented.

## Local HTTP MCP

Authenticated `/api/mcp`, full profile, real handlers, one prepared mission and
small fixture repository. Thirty interleaved warm requests per row. HTTP,
JSON-RPC and tool errors are rejected, rather than counted as fast samples.

| Operation | p50 ms | p95 ms | Worst ms |
| --- | ---: | ---: | ---: |
| tools/list | 12.04 | 108.11 | 127.87 |
| o8_status | 35.50 | 1,667.03 | 3,490.43 |
| get_mission_status | 21.34 | 72.35 | 193.03 |
| o8_task_list | 14.18 | 65.83 | 271.99 |
| o8_operator_defaults | 22.66 | 40.64 | 51.20 |
| o8_list_repos | 16.99 | 49.94 | 208.78 |
| o8_list_projects | 19.26 | 116.92 | 276.15 |
| o8_lease_list | 17.46 | 62.54 | 79.74 |
| o8_msg_agents | 18.38 | 33.29 | 35.01 |
| o8_problem_list | 8.63 | 12.75 | 61.41 |

The catalog exposed 128 tools in this build; discovery is measured, not assumed
to be expensive. `o8_status` has the dominant tail. A separate three-cycle CPU
profile contained 30.07 seconds idle/wait, 1.29 seconds in spawn and 0.44 seconds
GC. This supports an architecture/I/O hypothesis (inventory and subprocess
work), not a claim that serialization or GC causes the entire tail. Test a
coalesced inventory snapshot with explicit freshness before porting handlers.

## Streaming and input

Chromium, 1440 × 900, four open chat tabs, nine windows per arm. All tabs were
visited before measuring. Frame gaps are rAF intervals; dropped-frame counts
are estimates, not compositor counters. Input is trusted keydown → subsequent
frame. An observer-ready handshake precedes the key.

| Measure | One producer | Four producers |
| --- | ---: | ---: |
| Delivered session subscriptions | 1 | 1 |
| Frame gap median / p95 / worst ms | 16.70 / 50.00 / 300.00 | 16.70 / 16.80 / 233.40 |
| Input median / p95 / worst ms | 44.60 / 161.90 / 278.30 | 44.25 / 104.20 / 392.50 |
| Main-thread task ms/s median / worst | 529.62 / 908.23 | 500.63 / 634.82 |
| Script ms/s median / worst | 277.95 / 543.75 | 236.57 / 329.47 |
| Layout ms/s median / worst | 18.62 / 43.04 | 20.53 / 25.95 |

There were 123/142 input observations and zero censored inputs. Injecting a
150 ms keydown stall produced 165.5, 232.3 and 173.5 ms, validating the observer.
Earlier fixed-sleep observer trials had readiness races and are excluded.

For the chat path in #3462, hidden tabs unsubscribe: there were **zero extra
hidden subscriptions**. Four producers therefore did not deliver four streams
or reproduce hidden rendering overhead. The apparent arm difference is not a
causal speedup. Terminal and split-pane streaming are not covered by this chat
fixture. Visible transcript scripting/reconciliation is the runtime-bound
candidate; layout is smaller. Test unchanged-turn reuse and composer isolation,
then compare a GPUI transcript prototype with the same workload before choosing
a new surface.

## Memory and ownership

RSS is MiB, median / worst across three instances. Boot means server health
for the web lane and accepted input for the native lane. Workload start precedes
the paired heap snapshot. Hour RSS is taken before the final GC and snapshot.

| Process | Boot MiB | Workload start MiB | Hour MiB |
| --- | ---: | ---: | ---: |
| Source Next | 220.69 / 222.70 | 279.08 / 284.89 | 562.12 / 582.02 |
| Source WS | 252.95 / 257.30 | 228.87 / 231.62 | 232.55 / 239.75 |
| Native shell | 577.07 / 578.53 | 578.32 / 579.59 | 477.05 / 509.92 |
| Native Next | 310.11 / 314.23 | 321.21 / 323.07 | 719.56 / 743.73 |
| Native WS | 196.40 / 196.57 | 196.92 / 198.02 | 262.27 / 276.74 |

Source soaks ran 60.00–60.03 minutes; native soaks ran 60.69–63.24 minutes.
All six completed with no collection/feed errors and advancing workload.
Transient descendants are listed separately in the numeric receipt. Launchd-managed
WebKit XPC processes cannot be assigned by this PPID sampler and are excluded;
these are not whole-application memory totals.

Post-GC retained heaps, MiB median / worst:

| Process | Workload start | Hour |
| --- | ---: | ---: |
| Source Next | 123.93 / 124.18 | 123.89 / 124.25 |
| Source WS | 121.84 / 121.90 | 123.64 / 123.71 |
| Native Next | 128.84 / 128.98 | 129.12 / 132.89 |
| Native WS | 54.69 / 55.02 | 81.17 / 81.44 |

The native Next after-hour snapshots contain about 63.72 MiB shallow strings and
29.32 MiB code. The source lane has about 61.56 MiB strings and 27.03 MiB code.
The largest 1.72/1.34 MiB strings have strong paths through module loaders and
script source (`loadChunk`, `__next_require__` / `__next_chunk_load__`), before
and after the workload. These are shallow categories and shortest retaining
paths, not dominator-retained totals. No growing transcript cache was identified
in the Next snapshots. Loaded framework/module code is the dominant JS category.

Native WS retained heap grew about 26 MiB, mostly during the first ten minutes,
then fluctuated around a plateau through the hour. The source browser fixture
bypasses that real history bridge and its WS heap grew about 2 MiB. A concrete
retention candidate is the [WS realtime log](../../src/ws-server.ts), which keeps
400 envelopes, including full `history.snapshot` payloads, and trims by event
count rather than bytes. That bounded source path and the plateau are consistent
with replay-buffer filling; a WS heap ownership snapshot was not captured, so
the 26 MiB is not attributed exclusively to that array. Test a byte budget and
delta/checkpoint retention before treating this as an unbounded leak.

Verdict: **no unbounded retained-JS leak was demonstrated in this bounded hour**.
Next stayed near its warmed live-heap baseline. WS has bounded-retention evidence
and a remaining ownership hypothesis. The native shell has large startup
allocations; its RSS fell over the hour. This does not rule out leaks under
larger histories, more repositories, or longer installed-app use. Memory costs
here are runtime-bound code/allocator retention and architecture-bound snapshot
replay/native matcher retention.

The paired snapshots used in this capture perturb RSS. A separate warmed-MCP
control on three fresh source servers measured **276.65 MiB median / 282.96
MiB worst added RSS immediately after one heap snapshot and GC**; a one-second
idle control changed RSS by 1.38–7.86 MiB. That control is a different population,
so it must not be subtracted from individual soak values. The rerunnable harness
now defaults to taking the snapshot after hour RSS; `--paired-heaps` reproduces
the graph-comparison mode used here. This avoids treating profiler retention as
application leakage in the future ratchet.

A separate native diagnostic boot enabled malloc stack logging **only on its
own instance**. Complete allocation-stack aggregation found **476.50 MiB of
live allocated bytes** beneath `RemoteUrlPattern::from_str` →
`UrlPattern::parse` → `Component::compile` → `Regex::parse`, plus 3.31 MiB in
URL-pattern wrapper stacks. This is Tauri ACL setup inside the Rust shell.
Another 0.30 MiB of regex allocations belongs to shell-open scope. The dump's
large file/VM mappings are not heap and are not added to these totals.
Diagnostic logging overhead is excluded from startup and soak measurements.

Read-only installed-app observations corroborate the symptom but do not prove
the same retained owners: RSS was approximately 1.4 GiB shell, 2.8 GiB Next and
0.6 GiB WS. `vmmap` physical footprint was about 586 MiB shell and 885 MiB Next;
a native heap census found 495 MiB live allocations, predominantly non-objects.
RSS, live heap, virtual mappings and physical footprint are different measures.
In the installed Next observation, allocator zones contained 853.6 MiB resident
but 49.3 MiB reported live allocations; `MALLOC_LARGE_REUSABLE` alone contained
682.6 MiB resident and 8 MiB dirty. A separate tag-255 page-allocator region
contained about 1.2 GiB resident / 804.2 MiB dirty; `vmmap` cannot identify its
JavaScript owners. These measurements support allocator/reusable-page accounting
as part of the large RSS, not a claim that all live JS fits in 49 MiB. The
installed WS observation had 239.1 MiB physical footprint, including 57.2 MiB
reusable resident memory. No logging or profiler was enabled on either server.
The development allocation stack gives a concrete next experiment, not proof
of the installed Next process's ownership or an installed-app leak verdict.

## Ten next experiments, ranked

These are measured costs to target, **not additive savings estimates**. Rank
balances blocked startup/worker time, persistent memory and input responsiveness.
`runtime` means execution/GC/DOM work; `I/O` means files/Git/network;
`architecture` means initialization, process boundaries, polling or repeated work.

| Rank | Measured cost | Class | Proposed fix / acceptance experiment |
| ---: | --- | --- | --- |
| 1 | Worker preparation: Codex 35.65 s median / 39.43 s worst; guarded status adds 483.56 ms median per call | architecture | Rust workspace-guard helper or batched checks, preserving identical ownership/storage validation; compare end-to-end dispatch. |
| 2 | Real dependency APFS clone: 28.50 s median / 31.95 s worst | I/O | Design change: reuse validated dependency images or lazy materialization; measure readiness before accepting savings. |
| 3 | Native ACL matchers: ~480 MiB live; context 32.43 s median / 34.18 s worst | architecture | Design change in existing Rust: test shared compiled URL matchers with unchanged ACL semantics; remeasure context time and allocations. |
| 4 | Source server readiness: Next 12.18 s, WS 13.65 s median; WS worst 18.86 s | architecture | Design change: trim eager boot work and compare compiled WS bootstrap with the source-loader lane. |
| 5 | Spawn → assistant output: Codex 10.66 s upper-bound median; Claude token delta 4.99 s | I/O | Design change: warm CLI/provider transport and expose token deltas; separate CLI/auth/network/model time before a runtime port. |
| 6 | Visible transcript: 500–530 task ms/s median, up to 908; script 237–278 ms/s median | runtime | Design change: reuse unchanged turns and coalesce updates; benchmark a GPUI transcript surface against the same fixture. |
| 7 | MCP status: p95 1.67 s, worst 3.49 s | architecture | Design change: coalesce/push runtime inventory with explicit freshness, rather than spawning repeated discovery. |
| 8 | Composer: ~44 ms median, 392.5 ms worst | runtime | Design change: isolate draft updates from transcript work; evaluate a GPUI composer only against the same key-to-frame test. |
| 9 | Binding → runtime spawn: Codex 1.29 s median / 1.75 s worst | architecture | Design change: reuse a runtime carrier and batch launch discovery while preserving session isolation. |
| 10 | Native WS retained heap: ~26 MiB growth, then plateau; 400-envelope replay limit is a candidate owner | architecture | Design change: test byte-bounded replay and compact deltas/checkpoints; verify ownership in a WS heap before assigning all growth to replay. |

## Verification and decision

`npm test`: 1,190 files passed, 3 skipped; 8,375 tests passed, 4 skipped.
TypeScript passed with an 8 GiB Node heap after the default 4 GiB invocation
exhausted its heap. Generated provider plugin templates were preserved in hidden
fixture caches so the application's recursive typecheck cannot ingest them;
the exact typecheck then passed again. Touched ESLint, branch-point rule-check and
test classification passed. The roadmap check initially passed; its final live
refresh reports unrelated drift because the `Now` link #4082 has since closed.
No roadmap file was changed. Self-checks reject HTTP/JSON-RPC/tool failures,
preserve child-process promisify semantics, and reject an injected 120 ms delay
against an 80 ms calibration budget. No CI wiring, version bump or release.

Decision: keep this as an observational baseline. Implement one targeted
experiment at a time, use the same entry points and retained-state checks, then
repeat under controlled host load. The native matcher/guard findings justify
specific Rust work; these data do not justify a wholesale UI or server rewrite.
