# GPUIX transcript spike: blocked before build

The source audit triggered the requested stop rule. The default macOS build
needs an absent Apple Metal toolchain; installing it downloads outside the
allowed sources. Rust 1.97.1 is also absent. No install, build or benchmark ran.

| Median of >=3 runs | Native | Safari | Ghostty |
| --- | --- | --- | --- |
| Cold launch to first frame | NM | NM | NM |
| Streaming frame p50/p95/p99 | NM | NM | NM |
| Fast-scroll dropped frames | NM | NM | NM |
| Composer key-to-paint | NM | NM | NM |
| Idle RSS | NM | NM | NM |
| RSS after 5 min streaming | NM | NM | NM |

NM = not measured; n=0. Ghostty 1.3.1 is installed. Terminal mode is required
but blocked by the same native build. No Ghostty windows opened.

**Method, pending:** three scripted runs per surface, equal 1200x800 content areas,
one invented 2,000-turn fixture, 50 tokens/s, complete fast-scroll traversal,
and typing during streaming. Measure displayed frames, not React commits.
Use the page's WebContent PID; report terminal renderer and Ghostty RSS separately.
Capture the terminal's displayed frame and close only owned windows. See
[METHOD.md](METHOD.md); no measurement script exists yet.

**Documented gaps, not runtime findings:** nested vertical scrollers
(including an inner diff), inherited text colour, WOFF/WOFF2, springs,
keyframes, variants and shared-layout animations. Horizontal child scrolling,
TTF/OTF and numeric tween animations are supported.

**Rough effort:** list/tail/virtualization 2-4 person-days; markdown/code
3-6; diffs 3-5; tool groups 1-3; composer 4-8; layout/theme/fonts 2-4;
motion 2-5. Provisional estimates; exclude backend,
accessibility parity and production hardening.

**Recommendation:** make no migration performance claim. Resolve the toolchain
source exception, finish the audit, then benchmark. A Rust backend rewrite needs
separate evidence. [AUDIT.md](AUDIT.md) records the blocker and exact source pins.
