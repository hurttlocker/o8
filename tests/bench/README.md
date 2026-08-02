# o8 Benchmark Suite

This suite makes release claims measurable instead of anecdotal. It wraps the existing harnesses and writes version-stamped scorecards under `tests/bench/scorecards/`.

## Tracks

- Automatable: speed, memory, and governance.
- Operator-driven: coding. It remains `automatable:false` because it depends on a human-driven worktree head-to-head run.

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

## Manual Track

Coding:

```sh
cp tests/bench/coding.template.json tests/bench/latest/coding.json
```

Run the 3-arm worktree head-to-head, fill `passRate`, `arms`, `winner`, `date`, and `version`, then run `npm run bench:score`.

If governance is absent for a release, the scorecard records it as `automated — not run this release`. If coding is absent, the scorecard records it as `manual — not run this release`.
