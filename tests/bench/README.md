# o8 Benchmark Suite

This suite makes release claims measurable instead of anecdotal. It wraps the existing harnesses and writes version-stamped scorecards under `tests/bench/scorecards/`.

## Tracks

- Automatable: speed, memory, and governance.
- Operator-triggered: coding. It remains `automatable:false` because collection launches paid external workers and must be started deliberately.

## Release Run

Run against a running target build:

```sh
npm run bench:all
```

For the speed-only release preflight, run:

```sh
npm run bench:quick
```

The quick run stays under two minutes, writes `tests/bench/results/<version>.json`,
and compares its speed metrics with the previous release. The local ship
preflight runs the same measurement in an ephemeral directory. A regression or
missing measurement prints a warning but does not block an otherwise valid
release.

Then read:

```sh
tests/bench/scorecards/latest.md
```

`bench:all` runs speed, memory, the blind governance review, then scoring. Speed writes `tests/bench/latest/speed.json`; memory writes `tests/bench/latest/memory.json`; governance writes `tests/bench/latest/governance.json`; scoring writes `scorecard-<version>-<sha>.json`, a matching `.md`, and refreshes `latest.md`.

The speed track includes dashboard cold and warm HTTP timing, the desktop
workspace's splash and reveal boundaries, API request fan-out during boot, the
largest Resource Timing queue wait before an API request starts, and direct
latencies for `/api/panel/branches` and `/api/runtime/inventory`. Browser timing
uses a fresh headless Chrome profile against the running build. If Chrome, the
server, or a registered repository is unavailable, the scorecard records a
named missing measurement instead of substituting a number.

Run governance alone with:

```sh
npm run bench:governance
```

The governance command preflights 20 committed patch fixtures through TypeScript and ESLint, shuffles and neutrally labels them, and sends only task, acceptance criteria, and diff to the active AI reviewer. It records planted defects caught, clean diffs blocked, clean diffs with any finding, and inconclusive reviews with explicit denominators. It then refreshes the version-stamped scorecard. The result measures the AI review tier, not the human approval gate above it.

## Thresholds

- Latency metrics in milliseconds use an absolute ±25ms unchanged band.
- Accuracy and rate metrics from 0 to 1 use an absolute ±0.05 unchanged band.
- Judge variance is roughly ±5pp, so the ±0.05 threshold suppresses normal noise.
- `socket_avg_conns` is informational and never receives a regression tag.

## Coding Track

The coding track runs paired raw and contract-first arms for the two initial
runtime families. Every arm receives the same task, base, repository rules, one
turn, and timeout. A task is scored only when all four arms pass the independent
mechanical gates and both blinded judges return complete verdicts.

The same collection also runs a separate shipped-output experiment on issues
#1676, #1678, and #1679. It compares two single-pass ad-hoc diffs with the diff
that survives real mission dispatch, auto-review, and up to three normal
refix-and-review attempts. The governed artifact is the diff whose current HEAD
has a durable approved review, including any required contract coverage. It is
review-approved output, not merged output. The exact `main` commit is recorded in the receipt, and judging aborts
if worktree, mission, packet, lane, branch, or review-artifact provenance survives
blinding. Collection requires the `always` approval posture so the real pipeline
cannot merge while the benchmark captures the reviewed diff; the runner never
approves a card or invokes merge preview.

Preflight without launching workers:

```sh
npm run bench:coding
```

Collection and judging are separate so the paid phase is explicit and its raw
artifacts remain inspectable between phases:

```sh
npm run bench:coding:collect
npm run bench:coding:judge
npm run bench:score
```

The default run ID is `contract-v1`. Set `O8_BENCH_RUN_ID` before both commands
for later repetitions. Collection refuses to overwrite an existing run ID, so a
failed or unfavorable run remains in the receipts instead of disappearing.

`npm run bench:coding:all` runs collection and judging in one operator-triggered
command. The runner writes its receipts under the system temporary directory and
the decoded result to `tests/bench/latest/coding.json`. The fixed tasks and rubric
must not be edited after a run starts; record any deviation instead.

The shipped-output experiment can run independently with a fresh immutable run
ID, so a valid paired collection is not recollected or overwritten:

```sh
O8_BENCH_RUN_ID=<fresh-id> npm run bench:coding:e2e:preflight
O8_BENCH_RUN_ID=<fresh-id> npm run bench:coding:e2e
O8_BENCH_RUN_ID=<fresh-id> npm run bench:coding:e2e:judge
```

Standalone judging writes `tests/bench/latest/coding-end-to-end.json`, including
cost receipts, every invalid arm and its reasons, the three-attempt review bound,
and all recorded review findings. Collection and judging receipts under the run
directory remain immutable.

If governance is absent for a release, the scorecard records it as `automated — not run this release`. If coding is absent, the scorecard records it as `operator-triggered — not run this release`.
