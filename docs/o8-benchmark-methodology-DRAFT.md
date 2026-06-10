# o8 Benchmark Methodology — DRAFT (pending operator sign-off)

**Status:** DRAFT. Deliberately stored on the Desktop, OUTSIDE `~/cortex-ide`, so it is NOT spec-ingested into the Engineering Brain. Do not move it into the repo until it is locked and you've decided whether the Brain should know about it.

**Build under test:** installed `/Applications/o8.app` **v0.1.249** (verified live). Architecture is fixed and correct: **Claude Opus 4.8 orchestrator (REPL spawn, subscription-billed) routes work to a Codex GPT-5.5 xhigh worker in isolated worktrees, with operator review + approval before merge.** This benchmark **validates** that split — it does not propose changing it. The thesis is explicit: GPT-5.5 > Opus 4.8 at coding, so Claude-orchestrates / Codex-builds is deliberate.

**The one-sentence frame, never violated:** the headline number is SPEED, but the moat is **governance, organizational memory, and the operator-approval surface**. Cost and speed dashboards are table-stakes per `CLAUDE.md` — we measure speed because the blunt question is "is the app slow?", but every speed number is published as **"fast AND governed,"** anchored to success-rate and operator-attention, never speed alone.

**Honesty bar (applies to every track):** a benchmark that only flatters o8 is useless. Every track below names where the cheaper baseline (grep / Codex-alone / no-broker / a bare curl) **wins**, and how we'd detect it. If a track can't show its own losses, it is rigged and we don't ship its claim.

---

## 0. Ground truth verified live before writing this (read this first)

I checked the adversarial review's claims against the running v0.1.249 app and the live `~/.o8/cortex-ide.db`. Several recon assumptions were wrong; the document is corrected accordingly. **These are the load-bearing facts that change the plan:**

| Claim | Verified result | Consequence |
|---|---|---|
| `lane_events` verbs are `launch_session`/`running`/`merge`/`complete` | **FALSE.** Actual verbs: `status_change` (12,615), `update` (148), `attach_session` (57), `open_lane` (49), `auto_archive` (24), `merge_cleanup` (18), `merge_head_drift` (6), `zombie_reap` (3), `typecheck_auto_retry` (1), `agent_report` (1). Milestones are in `status_change` **payloads** (`launching/running/merging/reviewing/completed/archived/awaiting_input/idle/recovering/failed`). Column is `payload_json` (not `payload`); timestamp col is `timestamp` (TEXT). | **Every dispatch/wall-clock SQL in recon returns zero rows.** Re-derived against real verbs in §3.5 below. This is the #1 execution blocker and it is now fixed. |
| `usage.jsonl` lives in `~/.o8/` | **FALSE.** Lives at `~/.cortex-ide/usage.jsonl` (legacy dir), 732 rows, first row `gpt-5.4` @ 2026-04-18. | **Conflicts with the clean-bench mandate.** If usage logging ignores `CORTEX_IDE_DATA_DIR`, a `mktemp` bench DB produces ZERO usage rows and the [CODE]/savings token/$/wall-clock cells are empty. **MUST-RESOLVE in Phase 0** (open question Q3). |
| Bootstrap freshness headers gate every route | **PARTIALLY FALSE.** `/api/command-center/bootstrap` returns **404** on this build. The headers (`x-cortex-bootstrap-source/state`, `Server-Timing`) work **only on `/api/mobile/bootstrap`** (verified: warm = `hot-broker`/`total;dur=1.1`; `?fresh=1` = `degraded`/`total;dur=261.6`). | The honesty gate exists but covers the **mobile** route only. Do not claim it gates the desktop route. The desktop bootstrap is served differently (see §1.2). |
| `?fresh=1` doesn't change behavior | **FALSE — it works on mobile/bootstrap.** It flips source `hot-broker` → `degraded` and total 1.1ms → 261.6ms. **But `x-cortex-bootstrap-state` stayed `live` even when source=`degraded`.** | The cold/warm split is real and observable. **`source` is the honest signal; `state` is NOT reliable** on this route — gate on `source`, treat `state` as advisory. |
| `/` SSR route | 307 → `/dashboard`. Blind `/` measures only the redirect hop (77ms total with `-L`, 1 redirect). | Must measure `/dashboard` with `curl -L`, record both hops separately. |
| react-virtual imported by zero components | **FALSE.** Imported by `src/components/mobile/ChatView.tsx`. | Restate as **"no DESKTOP virtualization"** — mobile is virtualized, desktop chat is not. |
| `context-relay.ts` in `src/lib/cortex/` | **FALSE.** It's `src/lib/orchestrator/context-relay.ts`. The `startedAt: completedAt` bug at **line 527** is REAL (verified verbatim). | Path corrected; bug confirmed. 31/43 `session_outcomes` rows have `started_at==completed_at` and null/zero duration. **Never trust `session_outcomes.duration_ms`.** |
| `tests/qa-eval/cases.json` = 30 cases | **FALSE on disk: 4 cases** in the working tree right now. | Brain track question set is far thinner than recon claimed. **MUST expand to ≥30 before any Brain-wins claim** (Q5). |
| measure-render-speed.sh blind 3001 measures nothing | **FALSE here.** `~/.o8/api-port` = 3001 and `http://127.0.0.1:3001/api/panel/status` returns HTTP 200 in **3.6ms**. | Always resolve the port from `~/.o8/api-port` for portability, but on this machine 3001 is correct and live. Drop the anti-3001 anecdote. |
| `session_outcomes` mostly seed | TRUE-ish: 43 rows (39 succeeded / 1 partial / 3 failed), n is tiny + single-operator. | Outcome **classification** is usable; duration/token/cost columns are not. Coding wall-clock comes from `lane_events` + `usage.jsonl`, never the ledger columns. |

**Net:** the methodology design is sound and the carving of "is the app slow" is the right one, but ~8 net-new instrumentation items and the corrections above gate the marquee numbers. Phase 0 exists to fix these before a single published number.

---

## TRACK 1 — APP-SPEED (the headline)

### 1.0 How we bluntly answer "Is the app slow?"

We do **not** answer with one number. We answer with **six headline numbers** (§1.7) across the layers a user actually feels, each tagged cold|warm, each with its honesty caveat. The blunt answer ships as:

> "On this machine, v0.1.249 [is/isn't] slow: cold dashboard interactive in **X ms**, warm route TTFB **Y ms** serving hot-broker truth, transcript-load p95 **Z ms**, INP p75 **W ms**, dispatch spawn p50 **S s**, CLI command p95 **C ms**. Here's the distribution and here's where it degrades."

Day-one honesty caveat the operator must accept: **there is no absolute external baseline.** Cursor/VS Code are Electron (no comparable SSR route or WKWebView socket budget), so a cross-IDE app-speed comparison would be apples-to-oranges. On first run, "fast" is **regression-relative to a committed `baseline.json` that doesn't exist yet** — i.e. fast relative to nothing. The defensible day-one claim is the **absolute UX-grade thresholds** (Web Vitals "good", sub-frame commits, sub-second route loads), plus release-over-release regression once prior builds are in hand (§1.4).

### 1.1 What the app-speed surface decomposes into

1. **Route render / TTFB** — SSR `/dashboard` + `/mobile`, cold vs warm.
2. **Bootstrap source + freshness** — hot-broker vs degraded vs shell-only (the honesty gate, mobile route only on this build).
3. **Client hydration** — script-start → first-render → interactive, inside WKWebView.
4. **Web Vitals** — LCP / INP / CLS (net-new; the standard "laggy UI" numbers).
5. **Chat-transcript** — load / steady-state commit / streaming-append render.
6. **Realtime-socket health** — WKWebView ~6-conn/origin budget pressure + ipcFetch adoption + poll-abort coverage.
7. **Agent-dispatch latency** — queued → session-ready → first work.
8. **CLI latency** — `o8 <cmd>` cold-start + one loopback round-trip.
9. **MCP round-trip** — HTTP tools + the eval-seam timeout rate.

### 1.2 Metrics

| Metric | Definition | Unit | Capture | Target |
|---|---|---|---|---|
| **route_ttfb** | TTFB + total for `/dashboard` (via `-L` through the `/`→307) and `/mobile`, cold (`?fresh=1`) vs warm | ms p50/p95 | EXISTING `npm run measure:render` (`scripts/measure-render-speed.sh`), `BASE_URL=http://127.0.0.1:$(cat ~/.o8/api-port)`. **Patch the script to add `-L` and record both the 307 hop and the `/dashboard` render.** | Cold p95 < 800ms TTFB / < 1500ms total; warm p95 < 150ms TTFB |
| **bootstrap_source_freshness** | hot-broker \| degraded \| shell-only (+ state) per request. THE honesty gate. | categorical distribution | EXISTING headers on `/api/mobile/bootstrap` ONLY (verified). `source` flips correctly under `?fresh=1`; **gate on `source`, not `state`** (state stayed `live` while source=`degraded`). Desktop bootstrap (404 at that path) measured via the hydration marks instead (§1.2 client_hydration). | Warm: 100% hot-broker. Cold: degraded→hot-broker within one `BROKER_HOT_TTL_MS` (~12s) window. A warm "degraded" is a defect, not a slow number. |
| **per_route_server_timing** | Server compute per route from `Server-Timing` | ms | EXISTING on 5 routes only: `command-center/snapshot`, `browser/inventory`, `mobile/{inbox,bootstrap,sync}` (verified). **NET-NEW: add to hot desktop routes** (`/api/panel/repos`, `/api/panel/commits`, `/api/runtime/transcript`, `/api/worktrees/*`, `/api/cortex/ask/answer`) before this is credible for desktop. | total;dur p95 < 150ms cached/broker; flag any route p95 > 500ms |
| **client_hydration** | script-start→first-render, first-render→interactive, total | ms p50/p95, ≥10 cold launches | EXISTING `src/lib/perf/dashboard-marks.ts` emits real `o8:dashboard:*` PerformanceMarks + `[perf]`/`[boot-timing]` console lines on every cold boot. Read via `mcp__o8__o8_view_console_errors` / `o8_view_eval` on the installed app. Cold = kill + relaunch. | Cold p95: script→first < 400ms, first→interactive < 1200ms, total < 1800ms |
| **web_vitals** | LCP / INP / CLS in WKWebView | LCP ms p75, INP ms p75, CLS p75 | **NET-NEW**: PerformanceObserver for `largest-contentful-paint`, `event` (INP), `layout-shift`; log `[perf][vitals]`. Read buffered entries via `o8_view_eval`. **INP caveat:** INP needs real interaction entries, and we drive interactions through the same eval seam that breaks under load — so INP is measured but flagged as **lower-confidence** and cross-checked with screenshots. | LCP p75 < 1500ms, INP p75 < 200ms ("good"), CLS < 0.1 |
| **transcript_load** | tab-open/thread-switch → message-list paint. 3 sub-phases: network, server read+parse, client first paint. | ms p50/p95/**p99** by size bucket (short/med/long) | PARTIAL: client total via `o8_view_eval` `performance.getEntriesByType('resource')` (free). **NET-NEW: Server-Timing on `/api/runtime/transcript`, `/api/v2/chat-history`, `/api/v2/chat-history/list`** + a thread-load mark pair (dashboard-marks idiom). p99 matters: thread-restore does up to TWO sequential 6s-timeout fetches (worst-case ~12s hang). | Short p95 < 200ms, med < 500ms, long < 1200ms; **p99 never > 3000ms** |
| **steadystate_list_commit** | ChatMessageList commit duration vs message count (the no-DESKTOP-virtualization tax) | commit-ms vs N (50/200/500) | **NET-NEW**: React Profiler `onRender` or a commit-counter on `ChatMessageList`, log `[perf][list-commit]`. Drive a long thread in the installed app. (react-virtual IS used in mobile `ChatView.tsx`, NOT desktop chat.) | Commit p95 < 16ms (one frame) at N≤200; < 50ms at N=500. Above that = reintroduce virtualization. |
| **streaming_append_cadence** | flush rate + per-flush re-parse cost + dropped-delta rate on the LOSSY orchestrator channel | flushes/s, inter-flush ms, per-flush ms, dropped-delta % | PARTIAL: `eventCountRef`/`lastEventAtRef` already timestamp events. **NET-NEW**: `[perf][stream-flush]` counter + parse timer; dropped-delta counter in `ws-server.ts` `send()`. `flushCurrentAssistant()` fires per `output` event with no RAF batching. | Coalesce to ≤30 flushes/s; per-flush p95 < 16ms; dropped-delta < 1%. **Smoothness via dropped data is a defect, not a win.** |
| **socket_budget_pressure** | ESTABLISHED TCP conns webview→127.0.0.1:`<port>` vs WKWebView ~6/origin cap | concurrent count, max, sec-over-budget | EXTERNAL: `lsof -nP -iTCP@127.0.0.1 -sTCP:ESTABLISHED \| grep ":$PORT" \| wc -l` sampled @500ms during a scripted walkthrough. **NET-NEW supplement**: `window.fetch` concurrency gauge via `o8_view_eval`. | Idle max ≤3; under interaction max ≤6; time-over-budget = 0s. >6 with a hung fetch = exhaustion reproduced. |
| **ipcfetch_adoption** | migration burn-down off the socket budget | ratio + eligible-remaining count | EXISTING static grep: 5 ipcFetch files / 117 fetch-bearing files (verified). **NET-NEW**: invoke-success-vs-HTTP-fallback counter in `ipc-fetch.ts` (today only `console.warn`s). | All eligible exact-path GET sites migrated; fallback rate < 1% |
| **poll_abort_coverage** | fraction of `setInterval` polls that abort/guard the prior fetch | count guarded / total | EXISTING static grep: 22 AbortController files / 35 setInterval files (verified). Dynamic confirm: trigger a slow route, watch socket pressure climb tick-by-tick. | 100% of fast (<10s) polls have abort-or-guard |
| **agent_dispatch_latency** | `open_lane`→`attach_session` (Codex spawn cost) and `attach_session`→`status_change:running` (first work) | ms p50/p95 by wave size | EXISTING DB mining (no code change) — **re-derived against REAL verbs**, see §3.5. Correlate the `{queued:true}` MCP return ts with first lane event `timestamp`. Clean corpus on a fresh `CORTEX_IDE_DATA_DIR`. | queue→spawn p95 < 5s (single); wave-of-5 spawn p95 < 8s; spawn→first-work p95 < 50ms |
| **cli_command_walltime** | node spawn + 223,820-byte ESM bundle parse (~0.2s, no daemon) + config disk reads + one loopback round-trip | ms p50/p95, ≥20 cold invocations | **NET-NEW** `measure:cli`: loop `time node cli/dist/o8.mjs <cmd> --json` + exit code (EXIT contract 0/2/3/4/5). Isolate cold-start with `o8 --help`. Attribute server-vs-transport by subtracting a `curl -w` of the same route **on the same warm-server state**. | Cold-start p95 < 250ms; full command (status/doctor) p95 < 500ms warm-server. Under webview saturation, CLI stays within 1.2× idle (off-budget proof). |
| **mcp_roundtrip** | (a) HTTP tools overhead = client-total − server-time; (b) eval-seam timeout RATE under idle vs busy JS thread | ms p50/p95; timeout-rate % | PARTIAL: `cortex_ask` returns `retrievalMs`+`classifyMs` (verified). **NET-NEW**: `[mcp-timing]` stderr line per tool in `operator-mcp-server.ts` `tools/call`; `Instant` span + success/timeout counter in `tauri-plugin-mcp` `webview.rs eval_and_await`. A/B `o8_view_eval` (JS-dependent) vs `o8_view_screenshot` (Rust, always works) idle vs busy. | HTTP-tool p95 < 800ms; eval-seam timeout-rate < 5% idle (busy-thread rate documented as a known architectural limit, not eliminated) |

### 1.3 Baselines

- **PRIMARY — prior o8 versions, same harness.** Anchor tags: **v0.1.225** (pre-socket-fix, the documented 14-ESTABLISHED exhaustion), **v0.1.228** (push-not-poll Pass 1), **v0.1.249** (current). Release-over-release regression is the only true apples-to-apples baseline and the spine of the "getting faster" narrative. **DEPENDS on the old signed `.app.tar.gz` assets being installable** (Q1) — without them this spine AND the deliberate-bug-reproduction both collapse.
- **DOCUMENTED PERF-DEBT FLOOR, deliberately reproduced.** Reproduce the v0.1.225 socket exhaustion, the un-virtualized chat, the un-batched streaming setState, and the `?fresh=1` degraded path, and confirm the metrics **flag** them. A benchmark that can't see the known bug is untrustworthy.
- **WEB VITALS "good" thresholds** — the only external/absolute baseline available (LCP<2.5s, INP<200ms, CLS<0.1). o8 is local-first so it should beat "good" comfortably; failing to is a finding.
- **BARE-TRANSPORT FLOOR for CLI/MCP** — a direct `curl` (Bearer `~/.o8/ws-token`) to the same loopback route, measured **co-timed on the same warm-server state**. CLI overhead = CLI-total − curl; MCP overhead = MCP-total − curl − server-time. This exposes where a bare HTTP GET beats the MCP/CLI hop (honesty counter-case for simple status reads).
- **NO competitor-IDE baseline for app-speed** — stated explicitly rather than fabricated.

### 1.4 Cold vs warm (controlled per sub-surface)

- **Route/bootstrap:** cold = `?fresh=1` (verified to force the degraded/rebuild path on mobile/bootstrap), measured FIRST; warm = unparameterized after `BOOTSTRAP_SETTLE_SECONDS`. Always publish BOTH **and the `source`** — a warm number that secretly served `degraded` is the #1 honesty trap.
- **Hydration/Web Vitals:** cold = kill + relaunch `/Applications/o8.app` (marks are one-shot per boot); warm = in-session re-navigation. **Cold launch is the operator's real first-impression number — it is the headline.**
- **CLI:** no warm path (full spawn + parse every time). Report cold as the only number, but warm the SERVER first so the round-trip isn't measuring server cold-start.
- **Socket budget:** idle, then under scripted interaction, then under dispatched-packet load (three distinct failure modes).
- **Dispatch:** cold = first packet after launch (`discoverSessions` may balloon >10s — documented suspect); warm = subsequent packets with hot inventory (15s TTL). Report cold separately.
- **RULE:** every published number is tagged cold|warm; no warm number ships without its cold twin.

### 1.5 Sample protocol

- Route/CLI/curl (cheap): **N≥20** per route per state; report p50/p95.
- Client/UI (hydration, vitals, transcript, list-commit): **N≥10** cold launches (discard run #1 as JIT/disk warmup, keep 2–11).
- Socket pressure: continuous **1s sampling** across a scripted walkthrough (idle → open thread → open 3 panels → dispatch a packet).
- Eval-seam timeout rate: **N≥30** idle + **N≥30** busy (during a streamed reply) per tool.
- Dispatch latency (published): a **fresh ≥15-task corpus** on a clean `CORTEX_IDE_DATA_DIR`; historical `lane_events` for trend context only.
- Report median + p95 + IQR, **never a single "best" run**. Flag any metric where p95/p50 > 3× as high-variance and investigate before publishing. Run all builds back-to-back, same machine, same thermal/power state (plugged in), record host (machine, macOS, Node version) with every result set.

### 1.6 Honesty guardrails (app-speed)

1. **Warm-cache flattery** — every warm number ships with its cold twin AND its `source`; a "fast" number serving `degraded`/`shell-only` is disqualified.
2. **The `state` header lies on mobile/bootstrap** (stayed `live` under degraded source) — gate on `source` only.
3. **Single-machine bias** — record host+thermal+power; caveat that these are operator-machine numbers, not a universal SLA.
4. **Cherry-picked run** — always p50/p95/p99 + IQR; discard only run #1.
5. **Reproduce-the-bug proof** — deliberately reproduce v0.1.225 exhaustion + the degraded path and confirm detection.
6. **Eval-seam survivorship** — UI metrics read via the same flaky eval channel can drop slow samples; prefer Rust-side `o8_view_screenshot` to confirm state, **count eval timeouts as data**, cross-check with console capture.
7. **Lossy-channel hidden cost** — pair streaming cadence with the dropped-delta counter; fewer flushes via data loss ≠ smoother.
8. **Billing leakage** — app-speed measures TIME only; $ stays entirely in the savings track.
9. **Day-one self-reference** — no absolute "fastest" claim until prior builds give a regression baseline; until then, claim only against UX thresholds.

---

## TRACK 2 — BRAIN-vs-GREP

**Question:** does the Engineering Brain (Cortex v2, `cortex_ask`, BM25 directive-first retrieval) beat grep on retrieval/Q&A — and **where does grep win** (it does: literal/known-file lookups)?

### 2.1 Metrics

| Metric | Definition | Unit | Capture | Target |
|---|---|---|---|---|
| **answer_quality** | factual_accuracy + citation_correctness + hallucination_count, full vs naive-grep vs **strong-grep** vs blind, per category + per-case delta | 0.0–1.0; integer (hallucinations) | EXISTING `three-way-runner.ts` (Sonnet judge held constant), writes `tests/qa-eval/three-way-results-<ts>.json`. **NET-NEW: add a 4th strong-grep column to `baselines.ts`.** | full beats naive-grep (positive delta) AND beats strong-grep on structured categories (ownership/decisions/incidents/cross-repo); per-category factual_accuracy ≥0.70 |
| **retrieval_cost** | wall-time-to-last-token (p50/p95) + classify→retrieve→**compose** breakdown + tokens + USD, full vs strong-grep | ms; tokens; USD | EXISTING `classifyMs`+`retrievalMs` (`askCortex`/`cortex_ask`). **NET-NEW: instrument `composeClassA/B` + `openrouter-adapter.ts`/`sonnet-adapter.ts` to emit `composeMs` + token usage + cost.** Grep cost ≈ $0 + fs-read latency. | Report-only. Publish the break-even: where strong-grep ties full on accuracy, Brain must justify extra $/latency or be flagged as wrong tool. |
| **grep_wins_detector** | pre-tagged literal/known-file lookup cases where grep ties-or-beats quality at strictly lower latency+$ | count + (latency,$) delta | **NET-NEW: tag a `literal-lookup` category (~8 cases) in `cases.json`.** Compare full vs strong-grep on accuracy AND cost. | The suite MUST surface a non-empty grep-wins set, or the question set is biased toward Brain. |

### 2.2 Baselines

- **naive-grep** (EXISTS, `baselines.ts buildGrepTopRows`): top-15 keyword-hit lines over `CLAUDE.md` + `repos.json`. The strawman.
- **blind** (EXISTS): empty-rows floor — what the LLM knows from training alone.
- **strong-grep** (NET-NEW, REQUIRED): ripgrep over the full repo + targeted file reads + the same composer LLM. The realistic competitor. **Brain must beat THIS on structured questions to claim a win.**

### 2.3 Cold vs warm

`askCortex` is run with `bypassCache:true` in the full condition so every eval answer is **cold retrieval** — keep it (warm-cache hits would flatter Brain latency). Report Brain latency as cold (honest), separately note warm-cache latency (what a real user hits). The OpenRouter classifier pool is warmed at boot (#1123) — log whether it was cold or warm as a covariate.

### 2.4 Sample protocol

`cases.json` currently has **only 4 cases on disk** (verified — recon's "30" is wrong). **MUST expand to ≥30 (6 categories × 5) + ~8 literal-lookup = ~38** before any Brain-wins claim. Then: ~38 cases × 4 conditions × 3 repeats ≈ 456 generations. Report per-category means + per-case deltas + 95% bootstrap CI on the overall delta. Reuse the 478 `qa_eval_runs` rows + 8 historical three-way JSON files as priors (if they exist on disk — confirm).

### 2.5 Honesty guardrails (Brain)

1. **Strawman risk** — naive-grep is by-definition a strawman; without strong-grep every Brain win is suspect. Strong-grep is mandatory.
2. **grep genuinely wins** literal/known-file lookups; if the set has none, it's rigged — the detector must return non-empty.
3. **Self-confirmation** — `cases.json` was authored from the same DB the Brain ingests, and the judge is Sonnet (compose family). **Make the second-judge-family cross-check MANDATORY, not optional**, for the flagship claim.
4. **Tiny set** — 4 cases today; do not publish anything off 4. ≥30 first.

---

## TRACK 3 — WRAPPER-THESIS END-TO-END CODING

**Question:** does **o8-governed** (Claude routes → Codex 5.5 builds in worktree → review → merge) beat **Codex-alone** and **Claude-alone** on real tasks? Thesis: orchestrated+governed wins on **success-rate + low rework + low operator-attention**, NOT on raw wall-clock for trivial tasks.

### 3.1 Metrics

| Metric | Definition | Unit | Capture | Target |
|---|---|---|---|---|
| **task_success_rate** | fraction passing the oracle, per condition. **No test runner exists**, so success = `npx tsc --noEmit` clean AND `npm run lint` clean AND LLM-diff-vs-intent judge AND (governed) review-approved + merged_clean | % per condition | NET-NEW coding-track runner. o8 arm dogfoods REAL dispatch: `create_mission`→`dispatch_mission`→`wait_for_mission_ready`→`get_mission_status`→`submit_review`→`approve_and_merge`. Codex-alone = `codex exec` in bare worktree. Claude-alone = Claude REPL. | Governed ≥ both baselines on structured/multi-file buckets. **Bucket by diff size** — Codex-alone may match/beat governed on trivial single-file tasks; show the crossover. |
| **end_to_end_wallclock** | dispatch → mergeable result | ms/min | **PRIMARY: `~/.cortex-ide/usage.jsonl` `durationMs`** (real) + `lane_events` milestones (§3.5). **NEVER `session_outcomes.duration_ms`** (started_at==completed_at bug, line 527; 31/43 broken). | Report-only, bucketed. Governed is SLOWER on small tasks (review+merge tax, ~12s merge+archive + an orchestrator review turn). State it. |
| **tokens_and_cost** | input+output tokens + USD per task per condition, billing-normalized | tokens; USD | `usage.jsonl` per-packet + `/api/panel/analytics?hours=N` rollup. **Tag each row billing-pool (subscription vs metered).** | Report-only. Governed adds orchestrator+review overhead; the savings story is it AVOIDS failed-rework token cost on hard tasks. |
| **interventions_per_merge** | operator/orchestrator touches to land one clean merge: approvals + rejections + steers + redispatches + typecheck-escalation hits | count + approval-latency ms | `computeMoatMetrics()` gives approvalRate + avgLatencyMs. NET-NEW per-task rollup over `lane_events(actor IN user,orchestrator)` + `approval_events` + `typecheck_auto_retry`/escalation verbs, keyed laneId→packetId. | **The governance-moat headline.** Governed lands hard tasks with FEWER unrecoverable interventions than ad-hoc (which silently ships broken diffs). Show by diff-size bucket. |

### 3.2 Baselines

- **Codex-alone** — `codex exec` gpt-5.5 xhigh, bare worktree, no orchestrator/review/memory. The ad-hoc worker.
- **Claude-alone** — Opus 4.8 REPL, no Codex hand-off, no governance. The "one strong model does it all" counterfactual (fair test of the split, NOT an argument to change it).
- **o8-governed** — the system under test, via real MCP dispatch (dogfoods the product path).

### 3.3 Task curation (held-out)

Mine the **~1152 GH issues** on `hurttlocker/o8` (verified via `gh search`). Filter to **closed issues that map to a single merged PR** (issue text = spec, merged diff = ground-truth reference). **Hold out a set NOT seen during dev.** Bucket by diff size (single-file / multi-file / cross-cutting) so the crossover is visible.

### 3.4 Cold vs warm

Each task is effectively cold per condition (fresh worktree + agent session). The orchestrator/Brain classifier may be warm (#1123) — log it as a covariate since cold-start adds latency to the governed arm's first turn. **Confounder: run coding-track timing when the dashboard is QUIET, and log concurrent socket pressure as a covariate** — app-speed debt (socket exhaustion) can slow dispatch and contaminate this track's timing.

### 3.5 Re-derived `lane_events` timing recipe (REPLACES the broken recon SQL)

Verbs are NOT `launch_session`/`merge`/`complete`. Use the real schema (`payload_json`, `timestamp`):

```sql
-- Dispatch spawn latency (queue → worker attached), per lane:
SELECT lane_id,
  MIN(CASE WHEN verb='open_lane' THEN timestamp END)        AS queued_at,
  MIN(CASE WHEN verb='attach_session' THEN timestamp END)   AS attached_at,
  MIN(CASE WHEN verb='status_change'
            AND json_extract(payload_json,'$.status')='running'
           THEN timestamp END)                              AS running_at,
  MIN(CASE WHEN verb='status_change'
            AND json_extract(payload_json,'$.status')='merging'
           THEN timestamp END)                              AS merging_at,
  MIN(CASE WHEN verb='status_change'
            AND json_extract(payload_json,'$.status')='completed'
           THEN timestamp END)                              AS completed_at,
  MAX(CASE WHEN verb IN ('auto_archive')
            OR (verb='status_change'
                AND json_extract(payload_json,'$.status')='archived')
           THEN timestamp END)                              AS archived_at
FROM lane_events GROUP BY lane_id;
```

- **queue→spawn** = `attached_at − queued_at` (the Codex spawn cost headline).
- **spawn→first-work** = `running_at − attached_at`.
- **worker wall-clock** = `merging_at − running_at`.
- **merge latency** = `completed_at − merging_at`; **archive** = `archived_at − completed_at`.
- Escalation cost: count `typecheck_auto_retry` + `merge_head_drift` rows per lane.
- Join `lane_id → packet_id` via the `lanes` table; join `packet_id → usage.jsonl` for tokens/$.

### 3.6 Honesty guardrails (coding)

1. **Seed contamination** — wall-clock from `lane_events` + `usage.jsonl`; run on fresh `CORTEX_IDE_DATA_DIR`; never the historical ledger duration columns.
2. **Survivorship** — `mergedCleanRate` 24/24 on n=43 single-operator is pure selection bias; needs a held-out set + small-n caveat.
3. **Billing asymmetry** — Claude orchestrator sub-billed (~$0 logged), Codex worker metered. Report subscription token-draw AND metered $ separately; never sum costUsd naively.
4. **Weak oracle** — no test runner, so success = tsc+lint+LLM-judge. The judge can pass plausible-but-wrong diffs. **Spot-check a defined sample (≥20% of "passing" diffs) manually and report the oracle false-positive rate** (Q6).
5. **Crossover hiding** — governed loses raw wall-clock on trivial tasks; ALWAYS report by diff-size bucket, state where ad-hoc is the right tool.
6. **Live-system confound** — coding timing contaminated by app-speed debt; run quiet, log socket pressure.

---

## TRACK 4 — SAVINGS LEDGER

A **4-axis × 2-mode grid**: {time, attention, tokens, money} × {operator-now (MEASURED), future-user (MODELED)}. App-speed is **excluded** — TTFB has no honest conversion into this grid.

### 4.1 Metrics (grid cells)

| Cell | Definition | Unit | Capture |
|---|---|---|---|
| **TIME × now** | governed wall-clock-to-merge MINUS ad-hoc, median delta + IQR (not a sum) | sec/task + % | `lane_events` deltas (§3.5); ad-hoc arms bookended the same way |
| **TIME × future** | MODELED: measured median delta × {tasks/wk, lanes, team} | hrs/wk | calculator; MODELED banner |
| **ATTENTION × now** | interventions per merged-clean packet + decision-latency. **Two numbers, refuses to collapse into attention-dollars.** | count + ms p50/p95 | `approval_events` + `lane_events(actor)` + steer/rerun verbs |
| **ATTENTION × future** | MODELED: interventions-delta × tasks/wk | touches avoided/wk | calculator; dollarized ONLY under the same blended rate as time |
| **TOKENS × now** | SIGNED token delta per task AND per Brain query (governed/Brain often spend MORE) | tokens (signed) | `usage.jsonl`; Brain needs `composeMs`+tokens instrumentation |
| **TOKENS × future** | MODELED, signed | tokens/wk | calculator |
| **MONEY × now** (DERIVED, demoted) | normalized cost on ONE rate card so billing asymmetry doesn't fabricate a saving. A FUNCTION of time+tokens, never summed alongside them. | USD/task | impute ALL tokens (both arms) at one posted rate card (`ANTHROPIC_DEFAULT_PRICING` template); do NOT trust `usage.jsonl costUsd` for the delta |
| **MONEY × future** (calculator footer) | MODELED: the single $ a buyer wants. The ONE place attention-$ and time-$ co-appear, with mandatory overlap-subtraction. | USD/wk-mo | calculator with de-dup (money = time×rate + tokens×price, never additive across axes) |

### 4.2 Baselines & harness

- PRIMARY (measured): Codex-alone arm of the fresh 20–30 task A/B corpus (§3.3). The only baseline a headline savings number may cite.
- SECONDARY: Claude-alone arm.
- REJECTED: the historical `session_outcomes` ledger (n=43, mostly seed, broken duration). Sanity-check only.
- Harness: a `measure:savings` runner over the §3 coding A/B spine, writing a `savings_ledger` rollup (4×2) as JSON + a derived SQLite view. Future-user column is a pure projection over the measured spine.

### 4.3 Honesty guardrails (savings)

1. **Double-count** — money = time×rate + tokens×price; summing all four axes triple-counts one event. Money is DERIVED, never additive. Calculator runs a mandatory de-dup.
2. **Attention-dollars double-count** — attention reported as touch-count + latency; dollarized only inside the calculator under the same blended rate as time, overlap subtracted.
3. **Billing asymmetry** — normalize all tokens (both arms) to one rate card.
4. **Signed deltas** — Brain/tokens/time deltas are signed; show where grep/Codex-alone win.
5. **App-speed miscategorization** — KILLED from the grid; feeds the positioning sentence only ("app overhead is negligible vs agent wall-clock").
6. **Positioning drift** — headline stays on the ATTENTION cell (governance moat); money/token/speed are supporting confirmation.

---

## 5. SYNTHESIS & POSITIONING

The deck/story leads with the **moat**, uses speed as proof of seriousness:

1. **Governance** (ATTENTION × now) — "Governed lands hard tasks with N fewer operator interventions than ad-hoc, which silently ships broken diffs." This is the headline.
2. **Memory** (Brain track) — "The Brain beats a real ripgrep-agent on organizational/synthesis questions; on literal lookups grep wins and we say so."
3. **Wrapper-thesis** (CODE track) — "Claude-orchestrates / Codex-builds beats both single-model baselines on success-rate for multi-file work; on trivial single-file tasks ad-hoc is fine and we show the crossover."
4. **Speed as table-stakes-done-right** — "And the app isn't slow: [six headline numbers]. Speed is the floor, not the moat."

**Never** lead with "fastest" if the data shows governed is slower on small tasks — frame every speed number as "fast AND governed."

---

## 6. PHASED EXECUTION PLAN

### Phase 0 — Latest-versions + baseline snapshot + must-fixes (BLOCKS everything)
- **0.1** Confirm current build (v0.1.249 ✓) and resolve live port from `~/.o8/api-port` (3001 ✓, status route 200 @3.6ms ✓).
- **0.2** **Re-derive all `lane_events` SQL against the real verbs/status payloads** (done in §3.5) — verify each query returns rows on the live DB.
- **0.3** **Resolve the `usage.jsonl` path vs clean-bench conflict (Q3):** test whether usage logging respects `CORTEX_IDE_DATA_DIR` or always writes `~/.cortex-ide/usage.jsonl`. Decide ONE canonical timing source and verify it populates under bench isolation.
- **0.4** **Confirm prior signed builds (v0.1.225, v0.1.228) are installable (Q1)** — check `hurttlocker/o8` releases for archived `.app.tar.gz` NOW. Without them, kill the regression spine + bug-reproduction proof and say so.
- **0.5** **Patch `measure-render-speed.sh`**: add `-L`, record both the `/`→307 hop and `/dashboard`; confirm `?fresh=1` degraded behavior captured (verified working on mobile/bootstrap).
- **0.6** Commit `baseline.json` from the first clean `measure:render` + hydration run. All app-speed gates are regression-relative to it.
- **0.7** **Expand `cases.json` from 4 → ~30 + ~8 literal-lookup (Q5).** Build **strong-grep** in `baselines.ts` (Q4). Add `composeMs`+token+$ instrumentation to the Brain composer/adapters.
- **0.8** Decide MODELED assumptions for the savings calculator (Q7).

### Phase 1 — App-speed (the headline; ship the net-new instrumentation)
- Ship the ~8 net-new items: Server-Timing on hot desktop + transcript routes; web-vitals PerformanceObserver; React Profiler on ChatMessageList; `[perf][stream-flush]`/`[perf][vitals]`/`[perf][list-commit]`; `[mcp-timing]` stderr; `webview.rs` Instant span + timeout counter; ipc-fetch fallback counter.
- Build `measure:cli`, `measure:mcp`, `measure:socket`.
- Run the full cold/warm scorecard; reproduce the v0.1.225 exhaustion + degraded path to prove detection.
- **Deliverable: the six headline numbers + "is the app slow" answer.**

### Phase 2 — Brain-vs-grep
- Run `three-way-runner.ts` (full/naive-grep/**strong-grep**/blind) on the expanded ≥38-case set, 3 repeats; mandatory second-judge-family cross-check; publish per-category deltas + the grep-wins set.

### Phase 3 — Wrapper-thesis coding
- Curate the held-out GH-issue task set (closed→merged-PR, bucketed by diff size).
- Build the coding-track runner (3 conditions) + tsc/lint/LLM-diff oracle + manual false-positive spot-check.
- Run on fresh `CORTEX_IDE_DATA_DIR`, quiet dashboard, socket pressure logged.

### Phase 4 — Savings ledger + synthesis
- Build the rate-card module + `measure:savings` rollup over the Phase 3 spine.
- Produce the 4×2 grid (MEASURED now / MODELED future) + the positioning deck.

### What's native-sub-agent vs Codex-o8-dispatch work

- **Native Claude (me / sub-agents) — keep:** all SQL mining, harness/script authoring, the net-new instrumentation edits, running `measure:*`, driving the webview via `o8_view_*`, analysis + synthesis, the deck. These need this repo's context and judgment.
- **Codex-o8-dispatch — hand off:** the mechanical net-new instrumentation patches once specced (e.g. "add Server-Timing to these 5 routes per the existing pattern", "add `[mcp-timing]` stderr to `tools/call`", the `measure:cli` script) — small, well-scoped, test-via-tsc+lint, ideal governed-dispatch packets. The strong-grep baseline + composer token instrumentation are also clean Codex packets.
- **Operator only:** the Phase-0 decisions (Q1–Q8), installing prior builds, funding the OpenRouter key.

---

## 7. OPEN QUESTIONS FOR THE OPERATOR (decide before any run)

1. **Prior signed builds (v0.1.225, v0.1.228) — are the `.app.tar.gz` assets archived/installable?** If not, the release-over-release regression spine AND the deliberate-bug-reproduction (the #1 trust proof) both die. Do we accept "absolute-thresholds-only" day-one claims, or block on recovering old builds?
2. **Is the day-one "fast relative to nothing" caveat acceptable?** There is no external app-speed baseline (Electron IDEs aren't comparable). Are UX-grade absolute thresholds + future regression tracking enough, or do you want some external anchor I haven't found?
3. **`usage.jsonl` data-dir conflict:** if usage logging always writes `~/.cortex-ide/` regardless of `CORTEX_IDE_DATA_DIR`, the clean-bench produces zero usage rows. Do we (a) fix the writer to respect the env var, (b) formalize `lane_events` as the sole canonical timing source, or (c) run the coding A/B against the live DB and tolerate contamination?
4. **Strong-grep baseline scope:** how strong should the realistic grep-agent be — ripgrep + N file reads + the same composer, with what file-read budget? Too weak = strawman; too strong = it's basically the Brain.
5. **Brain question-set authorship:** `cases.json` has 4 cases and was authored from the same DB the Brain ingests. Who authors the expanded ≥30 + the held-out literal-lookup set so it isn't self-confirming — you, or a sub-agent with a no-peeking constraint?
6. **Coding success oracle:** no test runner exists. Is `tsc-clean + lint-clean + LLM-diff-vs-intent + (governed) review-approved` an acceptable success definition, and what's the manual false-positive spot-check sample size / acceptance bar?
7. **Savings calculator MODELED assumptions:** blended hourly rate, tasks/week, team size, rate card for token-$ normalization (incl. how to value the sub-billed Claude orchestrator).
8. **Scope/sequencing:** ship Track 1 (app-speed) as a standalone deliverable first, or hold everything for one combined report? (Track 1 answers the blunt question fastest; Tracks 3–4 are the heaviest lifts.)

---

## 8. ESTIMATED EFFORT & TOKEN COST

| Phase | Effort | Token/$ cost |
|---|---|---|
| **0 — must-fixes + baseline** | 1–1.5 days (mostly verification + small instrumentation + cases.json + strong-grep) | Low. Native Claude: ~150–300K tokens. No agent dispatch $. |
| **1 — app-speed** | 2–3 days (8 net-new instrumentation items, ~5 of them dispatchable to Codex; build 3 measure:* harnesses; full scorecard + bug-reproduction) | Native: ~400–700K tokens. Codex dispatch: ~5–8 small packets ≈ $3–8 metered. |
| **2 — Brain-vs-grep** | 0.5–1 day (harness mostly exists; expand cases, add strong-grep, run 456 generations) | OpenRouter judge+compose: ~456 generations ≈ **$8–20** depending on model. Native: ~150K. |
| **3 — coding wrapper-thesis** | 3–5 days (highest variance: curate held-out tasks, build 3-condition runner + oracle, 20–30 tasks × 3 conditions × 2 repeats = 120–180 agent runs) | **The big spend.** Codex worker runs: 60–90 governed/Codex-alone runs ≈ **$40–120** metered (varies wildly by task size). Claude-alone arm draws the subscription pool (effectively $0 metered). Native orchestration: ~600K–1M tokens. |
| **4 — savings + synthesis** | 1 day (rollup script + grid + deck) | Low. Native: ~200K tokens. |
| **Total** | **~8–12 working days** | **Metered $ ≈ $50–150** (dominated by Phase 3 Codex worker runs + Phase 2 OpenRouter). Native Claude orchestration ~1.5–2.5M tokens (subscription pool). |

Phase 1 alone (the blunt "is the app slow" answer) is **~3–4 days and < $10 metered** — the cheapest high-value slice and the recommended standalone first deliverable.

---

## 9. FIRST-PASS RESULTS — o8 v0.1.250 (operator machine, 2026-06-01)

Instrumentation (Server-Timing on 6 routes + web-vitals observer + measure:cli/socket/mcp) was built via governed o8 dispatch (mission-41482eb6-dc0, 3/3 merged clean) and shipped as **0.1.250**, then measured against the **prod build** (not dev). **Single-sample / single-machine — directional, not yet publishable; the rigorous pass needs N≥10 cold launches + the regression spine.**

| Layer | Number | Verdict |
|---|---|---|
| Warm `/dashboard` route TTFB | **15–17 ms** | excellent (sub-frame) |
| Bootstrap broker: warm hot-broker vs cold `?fresh=1` degraded | **0.2 ms vs 257 ms** | broker working; honesty gate real (gate on `source`; `state` lies) |
| **Cold app launch → first paint (FCP)** | **2305 ms** | **SLOW** |
| Cold launch → DOM-interactive / loaded | 2311 ms / 2762 ms | SLOW |
| Dashboard React mount → interactive | **87 ms** | fast — NOT the bottleneck |
| Cold-boot dominant cost | streamed SSR response **1768 ms** (cold backend) + **244 resources** | the lever |
| Dispatch spawn latency (queue→spawn) p50 | **~3.5–4 s** (tail 20–56 s under load) | acceptable; tail = socket pressure |
| Dispatch spawn→first-work | 2–11 ms | instant once attached |
| CLI cold-start (`o8 --help`) | **233 ms** median (status 429 / p95 576; doctor 327) | at target |
| Loopback route round-trip overhead | ~16 ms p50 (server ~4 ms for repos) | fast transport |
| Transcript-family server read (chat-history/list) | **1.5–2 ms** | fast server; p99 risk is the socket-hang path, not compute |
| **Idle webview→backend socket conns** | **~6 (= WKWebView ~6/origin ceiling)** | **STRUCTURAL RISK** — on-demand fetch has no headroom |
| Web Vitals support in WKWebView | `event`,`first-input`,`largest-contentful-paint` supported; `longtask` NOT | INP IS measurable (needs a real interaction session) |

**Blunt answer — "is the app slow?":**
1. **In-session / warm: NO, it's fast.** Routes sub-frame (15–17 ms), dashboard mounts in 87 ms, loopback ~16 ms, transcript reads ~2 ms.
2. **Cold launch: YES, noticeably — ~2.3 s to first paint.** But the bottleneck is the **cold backend's streamed SSR (1.77 s) + 244 resources**, NOT the React UI (87 ms). Lever = backend warm-start + bundle/resource reduction, not UI work.
3. **Structural risk: the webview sits at its ~6-connection socket ceiling even at idle**, so on-demand fetches can stall — the documented stale-panel/hang mechanism (v0.1.225). Lever = finish the ipcFetch migration (move idle pollers off the socket budget; Pass-2 backlog).

**Still for the rigorous pass:** N≥10 cold launches (variance/IQR), INP over a real interaction session, transcript p95/p99 by size bucket under socket pressure, and the **release-over-release regression spine** — install v0.1.225 (pre-socket-fix) + v0.1.228 (push-not-poll Pass 1), both confirmed installable, and reproduce the socket exhaustion as the #1 trust proof.
