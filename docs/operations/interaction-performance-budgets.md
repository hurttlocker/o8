# Interaction Performance Budgets

The interaction harness answers one question: does the operator-visible
interaction loop still feel fast on this build? It is the second half of the
speed surface. `npm run bench:speed` measures service latency (HTTP TTFB,
bootstrap, CLI, MCP); this lane measures what the operator actually touches —
shell readiness, warm relaunch, first accepted input, fleet reveal at scale,
active-context reveal, composer input, Design Mode, and a bounded soak.

Tracked in #1697. This document is the budget manifest that issue asks for.

## Commands

```sh
npm run bench:quick               # fixtures + service speed + interactions + scorecard
npm run bench:interactions        # the interaction lane alone, quick scale, source stack
npm run bench:interactions:full   # scales 50/250/1000, 15 samples, 60s soak, bounded 10m boot
npm run bench:interactions:release -- --archive-sha256=<64-hex> --release-git-sha=<40-hex>
npm run bench:interactions -- --target=release:/path/to/o8.app --archive-sha256=<64-hex> --release-git-sha=<40-hex>
```

`npm run bench:speed` does not run this harness — it prints a pointer to it.
Keeping the service-speed lane short is deliberate: it is the fast measurement,
and chaining a multi-minute browser harness onto it would make the normal speed
check unusable. `bench:quick` is the command that runs both.

## Scenario coverage against the issue contract

Every scenario #1697 lists is either measured here through a real rendered entry
point, composed from the lane that already owns it, or reported as an explicit
null with the reason. Nothing in the contract is silently absent.

| #1697 scenario | How it is covered |
| --- | --- |
| Cold launch to shell visible, workspace restored, first command accepted | Measured: `dashboard_cold_ready_ms` (the app's own `data-o8-dashboard-hydrated` boundary, stamped from a script installed before app code) and `first_interaction_accepted_ms` (hydration → a composer that accepts a keystroke). |
| Warm relaunch with persisted terminal, agent, canvas and browser state | Measured: `warm_relaunch_ready_ms`. State is established first (browser pane opened on the fixture page), then the surface is closed and reopened against the same stack, data dir and browser context. The receipt records exactly four restored facets separately (`warmRelaunchFacets`: `terminal`, `agent`, `canvas`, `browser`) so a facet that fails to restore is a named finding, not a silent pass. |
| Terminal keystroke-to-paint at 1, 4 and 12 live terminals | **Composed**, not duplicated: `composed.terminalWorkload` reads the committed terminal-workload receipt, re-runs its operator-locked budget check, and reports the N=1/4/12 distributions with full provenance (commit, dirty flag, build mode, timestamp). Re-deriving this from a chat composer would be a weaker metric answering the same question. |
| Tab and pane switching while transcripts and diffs stream | Terminal pane switching under load is composed from the same lane (the N=12 rapid-switch assertion). Workspace tab-pill switching is reported as `tab_switch_ms`, currently an explicit unavailable: a default workspace renders a single tab and therefore no pills. |
| Repo/worktree/agent navigation at 50, 250 and 1,000 rows, including active-context reveal | Measured through the rendered surface: `fleet_reveal_ms` clicks the left panel's **Projects** disclosure and waits until all N generated repository rows have painted; `active_context_reveal_ms` clicks the row labelled `<repo> repository` and waits for the app's own `<repo> · <branch>` active-context label. `repo_inventory_ms` measures the data path behind them and is reported alongside, not instead. |
| Design Mode arm, hover, selection, screenshot crop, prompt-ready on a local fixture page | Measured: `design_arm_ms`, `design_hover_ms`, `design_select_ms`, `design_prompt_ready_ms`, driven through the real toolbar control and real pointer input over a generated, seeded local fixture page served on loopback and loaded through the embedded browser pane. `design_screenshot_crop_ms` is an explicit unavailable: this path does not capture a crop in this build (`DesignModeOverlay` marks the crop as a later phase of the feature). |
| Idle memory, process count, WebSocket count, main-thread long tasks during a bounded soak | Measured: the `soak` block records long-task ms/minute, per-process count and physical bytes with growth, and the live WebSocket count on the realtime port. |

## Target lanes, and what "two release baselines" means

| Lane | What it runs | Budget-eligible |
| --- | --- | --- |
| `--target=source` (default) | Builds the stack from this checkout (`production` when `.next` exists, otherwise `next-dev`) | `production` yes, `next-dev` no |
| `--target=release[:path]` | Runs the **exact packaged server** out of a shipped `.app` bundle or extracted release artifact, against an isolated data dir | yes (`packaged`) |

**Two source stacks built from the same checkout are not two releases.** The
release lane exists so the two baselines #1697 requires come from two shipped
artifacts. The procedure:

```sh
# Shipped 0.1.727 observation
npm run bench:interactions:full -- \
  --target=release:/tmp/o8-1697-baseline-1727/o8.app \
  --archive-sha256=29f8b6bd69c348b805e048ef0ca7e47a9531ce108e7247ba9bd1b1e87aefd4c0 \
  --release-git-sha=508c7a1e7208e4a729a9ca5afe4bcd64e0354cbd \
  --output=tests/bench/results/interactions-release-0.1.727.json \
  --baseline=tests/bench/results/interactions-baseline-release-0.1.727.json \
  --write-baseline

# Shipped 0.1.728 observation, compared to 0.1.727
npm run bench:interactions:full -- \
  --target=release:/tmp/o8-1697-baseline-1728.65tm1p/o8.app \
  --archive-sha256=c9dea378aed0f0de6f46cc018a99d1078f6dee17e89e4d67cc242e05b241e70c \
  --release-git-sha=5236ea26af8214ca6241bb40aa39784fa6d5b0f8 \
  --output=tests/bench/results/interactions-release-0.1.728.json \
  --baseline=tests/bench/results/interactions-baseline-release-0.1.727.json \
  --write-baseline
```

Each release run writes `tests/bench/results/interactions-baseline-release-<appVersion>.json`,
so the two coexist and can be diffed. The budgets below stay `provisional`
(`INTERACTION_BUDGETS.status === 'provisional'`, `lockedBy === null`) until both
exist and the operator locks them.

Release observations require all three independent provenance links: the
notarized `.app`, the SHA-256 of its release archive, and a full 40-hex release
commit supplied through `--release-git-sha`. The commit is included in the
composite target digest. `target.buildGitSha` records this explicit binding;
`target.serverReportedBuildGitSha` preserves the server claim separately. A
non-null server claim that differs from the explicit binding invalidates the
receipt, and an incomplete identity can never be written as a baseline.

## Artifacts

| Path | Contents |
| --- | --- |
| `tests/bench/latest/interactions.json` | Full receipt: `o8/interaction-performance/v1` |
| `tests/bench/results/<version>.json` | Quick-suite result, `tracks.interactions` embeds the receipt |
| `tests/bench/results/interactions-baseline-release-<v>.json` | Per-release baseline |
| `tests/bench/scorecards/scorecard-<version>-<sha>.json` | Release scorecard, `tracks.interactions` |

Every receipt carries benchmark identity (`version`, `gitSha` of the checkout
that ran it) separately from measured-target identity (`appVersion`, explicit
release `buildGitSha`, separately preserved `serverReportedBuildGitSha`,
`buildMode`, and `platform`), plus the host profile, the release-artifact
identity when the release lane ran, the fixture identity (scale, seed, digest,
design-page digest), and the sample count behind every distribution.

## The measurement order is part of the contract

The scenarios run in a fixed order — cold boot, fleet reveal, active-context
reveal with composer readiness observed concurrently, keystrokes, Design Mode,
soak, warm relaunch, falsification, then inventory as the final measured step.
This is not incidental. Older packaged servers may continue an expensive fleet
scan after the browser aborts a bounded request; measuring inventory earlier
would contaminate every later interaction. The probe has a 10-second bound,
stops after the first timeout, and records that timeout as a numeric
`>=10000 ms` lower-bound budget failure before the isolated server is torn down.
A harness that lets its own step order drift is not comparable run to run.

## Budgets

| Metric | Statistic | Budget | Basis |
| --- | --- | ---: | --- |
| `dashboard_cold_ready_ms` | p95 | 4000 ms | Past the 3s+ tier a launch must show named stages; past ~4s it reads as stalled. |
| `warm_relaunch_ready_ms` | p95 | 3000 ms | A relaunch restoring persisted state should stay inside the 1–3s spinner tier. |
| `first_interaction_accepted_ms` | p95 | 2000 ms | A shell that paints but refuses typing is not ready. |
| `fleet_reveal_ms` | p95 | 1000 ms | The disclosure has no spinner in its path, so it must land in the 100ms–1s busy tier. |
| `active_context_reveal_ms` | p95 | 1000 ms | Same busy tier as the reveal it follows. |
| `composer_keystroke_to_paint_ms` | p50 | 75 ms | Matches the operator-locked terminal keystroke p50 so both input paths answer to one bar. |
| `composer_keystroke_to_paint_p95_ms` | p95 | 175 ms | Matches the operator-locked terminal keystroke p95. |
| `tab_switch_ms` | p95 | 400 ms | Same latency class as revealing a terminal. |
| `design_arm_ms` | p95 | 300 ms | Arming a mode is direct manipulation; the armed state settles inside the busy tier. |
| `design_hover_ms` | p95 | 100 ms | Hover is the 0–100ms tier — the label IS the feedback and cannot lag the pointer. |
| `design_select_ms` | p95 | 300 ms | The composer materializing after the stroke is the result of the gesture. |
| `design_prompt_ready_ms` | p95 | 500 ms | Stroke release to a focused prompt the operator can type into. |
| `design_screenshot_crop_ms` | p95 | 500 ms | Kept in the manifest so a missing capability reports itself instead of disappearing. |
| `repo_inventory_ms` | p50 | 1500 ms | The fleet-list request the panel waits on, median of five consecutive calls. |
| `repo_inventory_p95_ms` | p95 | 3000 ms | The worst of those five; a fleet list that stalls once still stalls the operator once. |
| `soak_long_task_ms_per_minute` | p95 | 750 ms/min | Matches the operator-locked terminal-workload long-task ceiling. |

The direct-manipulation ceilings are not invented: they come from this repo's
own interaction spec, `docs/design/STYLEGUIDE.md` §1 "Feedback timing tiers"
(0–100ms the result is the feedback; 100ms–1s a busy state; 1–3s a local
spinner; 3s+ named stages). A surface over its tier either gets faster or grows
the feedback its tier demands. The terminal-derived ceilings come from
`scripts/bench/terminal-workload/budgets.mjs`, which the operator already locked.

**These budgets are PROVISIONAL** until two release baselines exist and the
operator locks them. See the release lane above.

### Absolute plus delta

Every metric is reported three ways, and a run fails on either gate:

- **Absolute** — value against the budget above.
- **Accepted baseline delta** — value against the accepted baseline, with a
  per-metric noise band measured from repeated runs of the same build.
- **Release delta** — the scorecard compares the metric against the previous
  release's scorecard.

### Build-mode eligibility

Absolute budgets describe a `production` or `packaged` build. A `next-dev`
measurement is recorded with its value and an explicit `unavailable` status
naming the reason, never a pass.

## Phase attribution

| Phase | Source | Notes |
| --- | --- | --- |
| `serverWaitMs` | Navigation/Resource Timing `responseStart - requestStart` | Attributed only to requests that started inside the measured window. Null with the reason for input paths that issue no request. |
| `inputDelayMs` | Event Timing `processingStart - startTime` | Falls back to the `keydown`/`pointerdown` timestamp when Event Timing produced no entry. |
| `mainThreadMs` | Event Timing `processingEnd - processingStart`; long tasks for boot and reveal | The handler window, including React's synchronous render and commit. |
| `reactCommitMs` | — | Always null with the reason: React's commit phase is not separately exposed by the platform build. It is inside `mainThreadMs`. |
| `presentationMs` | Event Timing `startTime + duration - processingEnd` | Falls back to the second animation frame after the DOM reflects the change. |

Event Timing's `durationThreshold` is clamped to 16 ms by the specification, so a
sub-frame input produces no entry. The harness then uses its own frame-accurate
fallback and records which source it used (`eventTimingUsed`).

## The falsification probe

A harness that cannot fail proves nothing. Every run replays the exact trusted
keypress and paint observer on a harness-owned textarea with a deliberate
main-thread stall injected into the same interaction (`--inject-delay-ms`,
default 500 ms), then requires the same budget evaluator to reject that result.
The receipt includes the injector application count and an explicit
`delayExecuted` assertion. A skipped probe, zero applications, missing execution
proof, or a delay that does not break a keystroke budget makes the run `invalid`,
refuses baseline writing, and exits non-zero. Product composer availability is
measured separately, so a release UI failure cannot prevent calibration or hide
its own failed/unavailable metric.

## Cleanup

Each run verifies, and records in the receipt, that it left behind: no surviving
application-server, realtime-server, fixture-page-server or browser processes; no
listening sockets on the ports it allocated; no fixture data directory; no tmux
session rooted in its own fixture directory; and no git worktree that did not
exist before the run. Sessions rooted elsewhere are reported as foreign and never
killed — this machine runs several agents, and recency is not ownership.

## Statuses

| `runStatus` | Meaning | Exit |
| --- | --- | ---: |
| `pass` | Every contracted metric measured and inside budget, probe failed as designed, cleanup clean | 0 |
| `fail` | A budget was breached or a metric regressed past its noise band | 1 |
| `invalid` | The instrument could not prove it fails, or the run left residue | 1 |
| `incomplete` | A contracted metric was unavailable with a stated reason | 0 |
| `unavailable` | Nothing could be measured | 0 |

`incomplete` and `unavailable` are never reported as a pass. While Design Mode's
screenshot crop is unimplemented, a clean run reports `incomplete` by design.

## Measured baseline

<!-- MEASURED-BASELINE -->
