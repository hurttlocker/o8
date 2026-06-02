# o8 Benchmark Suite

This suite makes release claims measurable instead of anecdotal. It wraps the existing harnesses and writes version-stamped scorecards under `tests/bench/scorecards/`.

## Tracks

- Automatable: speed and memory.
- Operator-driven: governance and coding. These are always recorded with `automatable:false` because they depend on human-driven review or worktree head-to-head runs.

## Release Run

Run against a running target build:

```sh
npm run bench:all
```

Then read:

```sh
tests/bench/scorecards/latest.md
```

`bench:all` runs speed, memory, then scoring. Speed writes `tests/bench/latest/speed.json`; memory writes `tests/bench/latest/memory.json`; scoring writes `scorecard-<version>-<sha>.json`, a matching `.md`, and refreshes `latest.md`.

## Thresholds

- Latency metrics in milliseconds use an absolute ±25ms unchanged band.
- Accuracy and rate metrics from 0 to 1 use an absolute ±0.05 unchanged band.
- Judge variance is roughly ±5pp, so the ±0.05 threshold suppresses normal noise.
- `socket_avg_conns` is informational and never receives a regression tag.

## Manual Tracks

Governance:

```sh
cp tests/bench/governance.template.json tests/bench/latest/governance.json
```

Run the 5-diff governance review->refix workflow, fill `catchRate`, `fpRate`, `date`, `version`, and `nDiffs`, then run `npm run bench:score`.

Coding:

```sh
cp tests/bench/coding.template.json tests/bench/latest/coding.json
```

Run the 3-arm worktree head-to-head, fill `passRate`, `arms`, `winner`, `date`, and `version`, then run `npm run bench:score`.

If governance or coding are absent for a release, the scorecard records them as `manual — not run this release`.
