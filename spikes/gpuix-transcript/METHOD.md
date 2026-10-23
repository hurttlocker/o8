# Isolated measurement method

Run from this directory with `npm run build && npm run bench`. The root app and
root dependency graph are unchanged. The native addon must first be built from
the source pins with `test-support`, `--release`, and the explicit target.
Install the isolated browser with `npx playwright-core install webkit`.

## Boundaries

- Never post operating-system input, automate an installed application, activate
  a window, or launch a terminal host. The old desktop drivers are retired and
  retained only in ignored local evidence, outside executable entry points.
- Web: Playwright launches its own headless WebKit. In-page KeyboardEvent and
  InputEvent dispatch use the real WorkerPaneComposer handler. Performance marks,
  two requestAnimationFrame callbacks, and PerformanceObserver provide raw
  samples. `costMs` measures the synchronous React update and forced layout;
  `elapsedMs` ends at the second rAF. Neither establishes displayed key-to-paint,
  GPU completion, OS input queue cost, compositor drops, or refresh-rate cadence.
- Native: GPUIX's GPU-backed TestGpuixRenderer opens an offscreen window at
  (-10000,-10000), with `focus:false`. Test-only active status changes no OS
  focus. Keystrokes go through GPUI event dispatch; exact input and painted text
  must match. Flush runs GPUI until parked; the in-process completion callback
  reads the GPUI profiler's draw duration. An update includes two flushes and
  event drains. `drawMs` is the last draw's CPU build/layout/paint cost, excluding
  physical display presentation. The parent kills a run at nine seconds, and the
  process exits after recording its samples. No activation method is called.
- Terminal: a Python-owned PTY supplies a 1200x816 winsize to GPUIX terminal mode.
  A minimal Kitty protocol emulator refuses shared memory and decodes actual
  inline zlib/base64 RGBA images before acknowledging fences. Typed bytes enter
  only that owned PTY. Input must match the GPUI state, painted text and the decoded composer marker. Frame
  timestamps end at decode completion; they include transport, compression,
  readback, decoder, HTTP control, and scheduling costs, excluding any terminal
  GPU/compositor. This is an inline transport test, not a Ghostty benchmark.

No arm measures physical keyboard latency. Values with different completion
boundaries must not be divided to claim a renderer speedup.

## Fixture and schedule

One turn is one invented transcript entry. All arms verify the identical SHA-256
of the same 2,000-entry fixture. It contains prose, markdown, code, tools, and
20 diffs. The web arm imports production WorkspaceTranscript and
WorkerPaneComposer unchanged. Native and terminal share the same React GPUIX
component with 50 windowed rows, native markdown/diffs, simplified tool rows,
system sans and monospace fonts. Web diffs remain fenced markdown. These visual
and virtualization differences prevent a production-parity speed claim.

Each run requests the same 80 token additions, 20 keys during streaming, and
100 scroll anchors (19,39,...,1999). These are sampled jumps over the whole index
range, not proof that every turn was visibly traversed. Native records observed
visible ranges. A 20 ms target schedule is backpressured by measurement; achieved
rate is reported, never assumed to equal 50 tokens/s. The second-rAF wait also
limits the web driver. This short test is not a 300-second memory soak.

Three fresh processes/browser instances per arm, with production React in all arms. The initial accepted batch
rotated native/web/terminal, web/terminal/native, terminal/native/web. The final
native and terminal passes were recollected separately to fix production React
mode and enforce decoded composer-marker acknowledgement. Web samples did not
change. Order and active-desktop background load were not fully controlled. Results contain every sample, counts,
fixture hash, acknowledgements, and per-run p50/p95/p99. The report takes the
median of those per-run percentiles. Headless WebKit uses millisecond timer
precision. There is no controlled cold filesystem cache or refresh-rate claim.
Rejected probes remain in ignored raw evidence with reasons summarized in
results/rejected.json. Only the final accepted nine runs enter the summary.

## Needs an unattended on-screen run

`unattended-on-screen.swift` is the single read-only compositor sampler. It was
typechecked, never executed. It requires an explicit, manually prepared,
experiment-owned window ID with a `GPUIX benchmark` title. It captures only that
window for at most eight seconds; it does not create, activate, resize, close,
or send input to an app. Prepare native windows without activation and under
ten seconds lifetime; prepare a separate Playwright WebKit instance with in-page
input. A terminal-host window requires manual preparation by the operator.

Compile/run at the empty desk:

```sh
swiftc -parse-as-library unattended-on-screen.swift -o /tmp/gpuix-unattended-capture
/tmp/gpuix-unattended-capture <owned-window-id> <output.jsonl> 8
```

Repeat for each arm and each run while the app-owned/page-owned input driver
runs. Preserve that driver's monotonic event log. Correlate the resulting
ScreenCaptureKit complete-frame timestamps with each input's content marker;
raw capture cadence alone is not key-to-paint or dropped-frame proof. This
script supplies capture evidence, not an automatic nine-run compositor verdict.
Outstanding: displayed key-to-frame, actual terminal-host presentation, launch
to first displayed content, compositor scroll/stream drops and display scale/
refresh parity. A separate 300-second offscreen soak is also unmeasured.
