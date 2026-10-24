# Dashboard document and hydration

Issue [#4464](https://github.com/o8-run/o8/issues/4464).
The [numeric receipt](dashboard-startup.json) retains all six alternating launches,
every critical-path JavaScript chunk's decoded and encoded bytes, React commit
timings, long tasks, and regression evidence.

These are standalone production measurements in Chromium 154 on Linux with Node
22.23.4. Phase boundaries and the median convention follow
[native composer startup](native-composer-startup.md).

| Metric, median unless marked | Before | After |
| --- | ---: | ---: |
| Next render span, ms | 245.90 | 176.74 |
| Server request through response finish, ms | 351.44 | 284.79 |
| Dashboard document, ms | 625.80 | 290.10 |
| HTML bytes, decoded | 70,292 | 32,658 |
| Critical JS bytes, decoded | 3,208,636 | 2,732,952 |
| Critical JS bytes, encoded | 954,512 | 828,982 |
| Workspace hydration commit after HTML, ms | 429.90 | 405.70 |
| Painted-workspace hydration marker after HTML, ms | 531.70 | 489.60 |
| Long tasks per launch | 3 | 3 |
| Total long-task time through hydration, ms | 323 | 361 |
| Largest long task across the cohort, ms | 132 | 205 |
| Worst document, ms | 637.90 | 316.80 |
| Worst hydration, ms | 566.30 | 546.20 |

The document and hydration medians meet the 300 ms and 500 ms targets. The worst
samples still exceed those limits, and long-task time remains a cost of the
client mount. The receipt exposes those tails rather than filtering launches.

| Launch | Before document / hydration, ms | After document / hydration, ms |
| --- | ---: | ---: |
| 1 | 625.8 / 566.3 | 316.8 / 489.6 |
| 2 | 586.0 / 531.7 | 236.8 / 482.1 |
| 3 | 637.9 / 514.6 | 290.1 / 546.2 |

## Mechanic

Automatic optional startup previously began immediately after health. Its route
imports, telemetry, transcript repair, and indexing competed with the incoming
document on the Node thread. A bounded two-second grace period gives startup UI
priority. Headless servers still initialize automatically, and explicit bootstrap
requests retain their existing behavior.

The dashboard layout now server-renders the existing boot cover. It keeps the
page in the RSC tree so Next discovers the initial chunks, then mounts the same
desktop and restoration logic in the browser. The existing painted-workspace
hydration marker is unchanged.

Closed bottom Files, Browser, and Review implementations, Projects, and project
focus load when selected. The account SDK has a separate module; the provider and
workspace child placement remain stable. SDK loading has a coalesced promise,
eight-second timeout, contained failure state, and retry. The extracted account
bridge and SDK component bodies match the baseline; mocked account fixtures cover
engine selection, synchronization, sign-out, timeout, and recovery.

A Chromium CPU profile identified synchronous smooth-corner layout reads during
the initial commit. Dashboard frames now consume completed `ResizeObserver`
border-box sizes and use the same `generateClipPath` implementation. Corner
updates reuse the last observed size. Legacy observer formats retain a fallback
after layout. DOM children, frame styles, and the generated curves are preserved.

## Measurement

Both builds use `npm run build`, the production webpack standalone path used by
the release builder, with disposable build data. Each launch uses a fresh server,
data directory, fixture repository, browser context, and four saved session tabs.
The persisted fixture and bounded inventory/history transport come from the
existing speed harness. Repository and tab persistence use the real HTTP entry
points. No provider turn is sent.

The cohort alternates before and after three times in one Chromium process.
Each blank renderer completes two frames before navigation; no application
assets or dashboard route are warmed. Foreground settings match the interaction
harness. No build, other test, or CPU profiler runs during the final cohort.
Host activity and OS file caches are uncontrolled.

The observer records the real HTTP listener and Next's
`renderToResponseWithComponents` span. Navigation Timing supplies the document
boundary. A React DevTools commit hook requires the committed fiber tree to
contain the workspace, avoiding a false commit from existing SSR markup. The
unchanged hydration attribute supplies the painted-workspace boundary. Resource
Timing and Long Tasks supply the remaining browser measurements. Response bodies,
headers, credentials, and repository contents are excluded from the receipt.

After timing, every launch restores all four tabs, switches twice, opens Projects
and returns, verifies identical visible frame bounds and clip paths, preserves an
unsent draft, and clears it. Account/native behavior is checked with fixtures;
these numbers describe the standalone Chromium route.

To reproduce after building, select Node 22 and run:

```sh
O8_DASHBOARD_STARTUP_CHECK=1 \
O8_DASHBOARD_STARTUP_RECEIPT=work/dashboard-startup/receipt.json \
npx vitest run tests/dashboard-startup-real-path.test.ts
```

For an alternating comparison, preserve the baseline build's `standalone/` and
`static/` directories outside the checkout, then set
`O8_DASHBOARD_STARTUP_BASELINE` to their parent directory. The probe copies the
same static resources that the release server export receives.

## Regression evidence

The receipt retains red tails from tests written before each remedy:

| Real entry point test | Before | After |
| --- | ---: | ---: |
| `src/app/dashboard/layout.test.ts`: server desktop render calls | 1 | 0 |
| `src/components/desktop/contextual-panel/surfaces.test.ts`: closed utility imports | 3 | 0 |
| `src/app/dashboard/deferred-panels.test.ts`: closed navigation imports | 2 | 0 |
| `tests/startup-stage-diagnostics.test.ts`: bootstrap requests before 2 s | 2 | 0 |
| `src/components/auth/O8AuthProvider.loading.test.ts`: unused SDK imports | 1 | 0 |
| `src/app/dashboard/DashboardFrame.test.ts`: commit-time style reads | 1 | 0 |

Initial production budget red tail:

```text
AssertionError: document median < 300 ms: expected 590.7 to be less than 300
AssertionError: hydration median < 500 ms: expected 579.4 to be less than 500
Test Files  1 failed (1)
Tests  1 failed (1)
```

Final standalone green tail:

```text
Test Files  1 passed (1)
Tests  1 passed (1)
```

The focused preservation suite passes 14 files and 88 tests, including saved tile
layout, workspace pages, right-panel persistence, bottom-terminal continuity,
panel file scope, account recovery, and exact frame clipping/child preservation.
An independent read-only authentication review found no remaining issues after
the SDK timeout and failure-containment checks were added.

The existing account fixtures now await the deferred SDK module, retaining their
enrollment, renewal, callback cancellation, and sign-out assertions:
`src/components/auth/O8AuthProvider.environment.test.ts`,
`tests/device-session-bridge.test.ts`, and
`tests/desktop-handoff-provider-real-path.test.ts`.
`tests/cold-start-instrumentation.test.ts` advances the new two-second grace
period before asserting packaged automatic startup. The latter three files pass
31 tests together. The first full gate exposed the stale fixture timing:

```text
Test Files  2 failed | 1210 passed | 3 skipped (1215)
Tests  7 failed | 8546 passed | 4 skipped (8557)
```

After those fixture waits, the final full `npm test` gate passed in 288.14 s:

```text
Test Files  1212 passed | 3 skipped (1215)
Tests  8553 passed | 4 skipped (8557)
```

The normal standalone production build passed. The requested
`NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit` passed, as did ESLint
on all 23 touched JS/TS files, rule-check against `origin/main` (10 runtime
files, zero violations), the test-classification check, receipt consistency,
and `git diff --check`. No release, version, deployment, or publishing files
changed. These are local verification results; remote CI is separate.
