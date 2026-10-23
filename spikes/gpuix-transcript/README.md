# Isolated transcript comparison

Three accepted runs each: GPUIX offscreen test window, Playwright headless WebKit,
and GPUIX through an owned PTY with inline Kitty RGBA decoding. All acknowledge
20 keys, 80 tokens, and the same 2,000-entry fixture hash. Each samples 100 scroll
anchors. See [raw results](results/summary.json), [per-run numbers](results/TABLE.md),
[draw costs](results/DRAW-TABLE.md), and [method and limitations](METHOD.md).

These are internal completion boundaries, not displayed key-to-paint. WebKit
reports JS/React/layout and second-rAF timing. Native reports in-process GPUI
flush completion and CPU draw costs. Terminal reports PTY decode completion and
CPU draw costs, with no terminal-host compositor. The short backpressured driver
does not sustain the requested token rate on every arm. No OS input was posted;
no installed browser or terminal app was driven. Native accepted lifetimes stay
below nine seconds without activation. Legacy desktop probes are rejected.

**Recommendation:** retain the production renderer. If a native rewrite is
pursued, choose pure GPUI for the core; use GPUIX for bounded prototypes.
GPUIX's documented nested-scroll, font, inheritance and motion gaps require
parity work, and its React windowing and tool-group behavior need app code.
Pure GPUI was not benchmarked, so this is a capability and control recommendation,
not evidence of a pure-GPUI speed advantage or a Rust backend speedup.

**Needs an unattended on-screen run:** displayed input-to-frame, terminal-host
presentation, cold first displayed content, and compositor scroll/stream drops.
The one read-only [capture script](unattended-on-screen.swift) is typechecked and
unexecuted. It requires explicitly owned, manually prepared windows and records
at most eight seconds. Display refresh/scale parity and a 300-second memory
soak remain unmeasured. No merge or release.
