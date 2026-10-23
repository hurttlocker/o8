# Four-arm transcript comparison

Three fresh runs each: pure Rust GPUI, GPUIX test window, isolated headless
WebKit, and GPUIX through an owned PTY. All use the same hashed 2,000-turn fixture,
80 token additions, 20 in-process/owned-PTY inputs and 100 scroll anchors.

| Median | Pure GPUI | GPUIX | WebKit | PTY |
| --- | --- | --- | --- | --- |
| Key to internal frame ms | 1.22 | 12.14 | 26.50 | 29.36 |
| Stream CPU frame cost ms | 0.57 | 2.19 | 53.50 | 2.64 |
| Scroll CPU frame cost ms | 0.59 | 2.64 | 3.00 | 2.48 |
| Idle RSS MiB | 37.56 | 113.62 | 491.90 | 150.53 |
| Launch to first internal frame ms | 182.50 | 616.44 | 2990.26 | 1000.75 |

These are different internal endpoints, not displayed latency or an isolated
bridge comparison. Pure GPUI uses a different engine snapshot and simpler cached
formatting. An earlier batch had a 3.21-second cold outlier, preserved in raw evidence.
Host/decoder memory is included and identified. Target cadence is backpressured.
See [all per-run percentiles](results/TABLE.md), [raw summary](results/summary.json)
and [method](METHOD.md).

**Recommendation:** advance the pure GPUI candidate for the native transcript.
Its measured CPU/input/memory costs support the next acceptance step. The UI
dependency is published Apache-2.0 gpui 0.2.2; locally authored formatting avoids
GPL application crates. The [linked dependency audit](results/pure-license-audit.json)
found no GPL package. Keep production unchanged until full composer/markdown/diff,
accessibility and compositor parity pass. This does not establish a backend gain.

No OS input, installed-app automation or activation was used. Pure GPUI is hidden;
GPUIX stays offscreen; native runs have a nine-second parent cutoff. Displayed
latency, GPU completion, terminal-host presentation and compositor drops remain
on the unattended list. The [capture sampler](unattended-on-screen.swift) remains
unrun. No merge or release.
