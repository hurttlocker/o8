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

Then read:

```sh
tests/bench/scorecards/latest.md
```

`bench:all` runs speed, memory, the blind governance review, then scoring. Speed writes `tests/bench/latest/speed.json`; memory writes `tests/bench/latest/memory.json`; governance writes `tests/bench/latest/governance.json`; scoring writes `scorecard-<version>-<sha>.json`, a matching `.md`, and refreshes `latest.md`.

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
that survives real mission dispatch, auto-review, autonomous refix, and merge
preview. The exact `main` commit is recorded in the receipt, and judging aborts
if worktree, mission, packet, lane, branch, or review-artifact provenance survives
blinding. Collection requires the `always` approval posture so the real pipeline
cannot merge while the benchmark captures its merge-ready diff.

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

If governance is absent for a release, the scorecard records it as `automated — not run this release`. If coding is absent, the scorecard records it as `operator-triggered — not run this release`.
