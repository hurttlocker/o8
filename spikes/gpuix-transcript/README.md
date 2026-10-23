# GPUIX transcript spike: blocked before build

The source audit triggered the requested stop rule. The default macOS build
needs an absent Apple Metal toolchain; installing it downloads outside the
allowed sources. Rust 1.97.1 is also absent. No install, build or benchmark ran.

| Median of >=3 runs | GPUIX | Safari/WebKit |
| --- | --- | --- |
| Cold launch to first frame | unmeasured | unmeasured |
| Streaming frame p50/p95/p99 | unmeasured | unmeasured |
| Fast-scroll dropped frames | unmeasured | unmeasured |
| Composer key-to-paint | unmeasured | unmeasured |
| Idle RSS | unmeasured | unmeasured |
| RSS after 5 min streaming | unmeasured | unmeasured |

n=0 on both sides. Terminal mode skipped: neither kitty nor Ghostty found.

**Method, pending:** three paired scripted runs, equal 1200x800 content areas,
one invented 2,000-turn fixture, 50 tokens/s, complete fast-scroll traversal,
and typing during streaming. Measure displayed frames, not React commits.
Resolve the page's Safari WebContent PID and sample its RSS separately from
the native process. See [METHOD.md](METHOD.md); no measurement script exists yet.

**Source-documented gaps, not runtime findings:** nested vertical scrollers
(including an inner diff), inherited text colour, WOFF/WOFF2, springs,
keyframes, variants and shared-layout animations. Horizontal child scrolling,
TTF/OTF and numeric tween animations are supported.

**Rough port effort:** list/tail/virtualization 2-4 person-days; markdown/code
3-6; diffs 3-5; tool groups 1-3; composer 4-8; layout/theme/fonts 2-4;
motion 2-5. Low-confidence engineering estimates, not measured; exclude backend,
accessibility parity and production hardening.

**Recommendation:** make no migration performance claim. Resolve the toolchain
source exception, finish the audit, then benchmark. A Rust backend rewrite needs
separate evidence. [AUDIT.md](AUDIT.md) records the blocker and exact source pins.
