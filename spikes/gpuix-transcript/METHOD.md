# Pending measurement method

Not executed. No measurement script exists. Both sample counts are zero.
The source audit stop rule takes precedence over building this harness.

1. Finish the build/download audit after the toolchain boundary is resolved.
   Use the source pins and lock hashes in `source-pins.json`; explicitly target
   `x86_64-apple-darwin`. Pin every direct dependency exactly and commit the local
   lockfile. Never install into the root or change product components.
2. Generate one deterministic invented fixture: 2,000 turns containing user and
   assistant prose, markdown, code, tool rows, and a fixed count of diffs. Define
   whether each turn is a message or exchange and record counts/bytes/hash.
   Append identical token strings on a 20 ms schedule; record achieved rate.
3. Render GPUIX with windowed `virtual-list`, native markdown/code/diff and a
   composer. Use system sans and monospace fonts, the existing transcript's
   font size, theme, spacing and activity grouping. Record any visual compromises.
   Do not give a diff its own vertical scroller inside the scrolling transcript.
4. Use the real `WorkspaceTranscript` and worker composer in a development-only
   preview following `src/app/preview/worker-transcript/`. Keep the preview app
   and its route inside this spike, importing the existing components unchanged.
   Preserve production rendering/virtualization behavior and record the exact
   source commit. A mocked HTML transcript is not the baseline.
5. Use actual Safari, not a Playwright WebKit substitute. Run one side at a time
   in the foreground with an equal 1200x800 content viewport, display scale,
   refresh rate and font settings. Verify the viewport; do not equate outer window
   bounds with the page viewport. Preserve unrelated browser windows and tabs.
6. Script at least three paired runs with alternating order. Define cold launch
   as launch/navigation to the first displayed transcript frame. Keep the dev
   server ready and report compilation/cache state separately. Do not claim a
   cold filesystem cache unless it was actually controlled.
7. Establish a common displayed-frame timestamp method for both surfaces before
   collecting numbers. Native CPU render duration, React commit duration,
   requestAnimationFrame cadence and actual presentation latency are different
   quantities. Keep raw presentation timestamps and instrumentation overhead.
   Use streaming frame intervals for each run's p50/p95/p99; count missed display
   intervals during a scripted fast traversal that proves all 2,000 turns were
   traversed. Preserve scroll path, speed, duration and coverage evidence.
8. During streaming, inject timestamped real keyboard input into the focused
   composer and detect the corresponding displayed glyph. Retain each input and
   presentation pair. Event-to-next-rAF alone does not establish key-to-paint.
9. Resolve each page's actual Safari WebContent process, not Safari's browser
   process, networking process or an arbitrary matching PID. Preserve process
   attribution evidence. Sample that PID's RSS and the native app's RSS at idle
   and after 300 seconds of streaming, with equal sampling semantics. Record
   helper processes separately rather than silently folding them into one side.
10. Report the median of per-run values, including the per-run percentile values,
    with raw sample counts. Reject invalid runs with reasons; retain them rather
    than retrying invisibly. Do not infer a Rust backend speedup from renderer data.

If kitty or Ghostty becomes available, `GPUIX_TERMINAL=1` is a separate terminal
experiment, not a substitute for native desktop measurements. Do not install one.
Put any future screenshots only on `pr-proof-assets` under the PR number, never
in this branch's commits or release assets. This blocked run has no screenshots.
