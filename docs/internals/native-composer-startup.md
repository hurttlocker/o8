# Native launch to interactive composer

Issue [#4436](https://github.com/o8-run/o8/issues/4436).
The [numeric receipt](native-composer-startup.json) contains three launches per
arm and the phase definitions. This measures an unsigned, uninstalled native
release artifact with real bundled application servers.

## Results

| Phase, median ms | Before | After |
| --- | ---: | ---: |
| Native boot through sidecar spawn | 1,169 | 1,071 |
| Server startup and verified identity navigation | 5,054 | 2,362 |
| Dashboard document | 1,679 | 1,933 |
| Frontend hydration | 1,327 | 1,285 |
| Workspace restoration and accepted input | 2,707 | 1,988 |
| Launch to interactive composer | 11,774 | 8,635 |
| Loader first paint, overlapping | 1,666 | 1,569 |

Each phase median is computed independently, so their medians need not sum to
median total latency. The receipt also records native context, window, shell,
Node preflight, Next/WS health, tab request and input-to-paint timings.

| Sample | First paint before / after, ms | Interactive before / after, ms |
| --- | ---: | ---: |
| 1 | 1,878 / 1,659 | 13,274 / 8,916 |
| 2 | 1,666 / 1,417 | 11,774 / 8,022 |
| 3 | 1,557 / 1,569 | 11,620 / 8,635 |
| Median | 1,666 / 1,569 | 11,774 / 8,635 |
| Worst | 1,878 / 1,659 | 13,274 / 8,916 |

Interactive median improved by 3,139 ms (26.7%). **Neither the 1 s paint target
nor the 3 s interactive target is met in these measurements.** During the
cohort, the host reported `CPU_Speed_Limit = 45`, then 60 after it. A later
reading briefly reached 100, but a fresh cohort's recovery gate saw 74-90 and
started no samples. The bounded gate requires at least 95; it does not change
power settings. The complete CPU-limited cohort above is retained. Unthrottled
reference-host acceptance remains open. Document rendering, frontend hydration
and remaining workspace restoration are the next measured costs.

## Source history

The measured source pair is base `64f95f691` and implementation `7c99f420b`.
While the artifacts were building, [#4437](https://github.com/o8-run/o8/pull/4437)
independently landed the same request-time route-loading setting on main. The
branch refresh preserves that setting unchanged. This PR's additional runtime
change is the primary workspace import; it also retains the route-loading
regression and the combined measurements. These numbers precede the refresh to
main `1834e625c`; current-main budget acceptance remains open.

## Mechanic

Next's default production startup walks and imports every route, including
unrequested API handlers. A diagnostic trace showed unrelated route imports
occupying the first health request. `experimental.preloadEntriesOnStart: false`
keeps those routes outside startup and loads them when requested instead.

The primary workspace also used `React.lazy`, starting a second code download
after dashboard hydration. Importing that required workspace with the dashboard
overlaps its download with the initial page resources. Repository scope gates
still decide whether it mounts; persistence, authentication, storage admission,
and runtime recovery checks are unchanged. Inspector code remains lazy.

## Measurement

The native build follows [the ACL measurement method](native-acl-startup.md):
normal optimized Cargo release, custom protocol, a separate application
identifier, empty external binaries, and optional speech helpers excluded to
avoid their build-time signing hook. Both arms use the same instrumented native
binary and loader. Their server resources come from normal production builds.
An unsigned host-ABI export copies the already compiled native addons instead
of invoking the exporter's signing step. An ignored fixture directory is
excluded from standalone tracing in both builds; this is not a shipped change.

Each launch uses a fresh disposable home, data directory, repository, native
socket and non-production API/WS ports. The native test contract disables
production lifecycle cleanup. The profile contains four completed provider
sessions with bounded synthetic histories. No provider turn or message is sent.
Only owned process groups are stopped between launches. No installed app or
its data is controlled. No signing, notarization or installation is performed.

The unchanged speed harness supplies the persisted fixture and loader paint
observer. A private native initialization script records navigation, resources,
hydration and fetch timings without recording bodies, query strings or headers.
Foreign loopback ports are refused by the observer in both arms. The loader's
normal expected-boot identity check remains intact.

Interactive means the active textarea is visible, writable and unobscured at
its center point. The probe focuses it, changes its value and dispatches an
in-process input event. After two animation frames, React must have enabled
the real Send control. It then clears the unsent draft and verifies Send is
disabled again. This uses no OS input and does not claim trusted keyboard or
OS compositor timing. First paint is WebKit Paint Timing for the original loader.

The final comparison alternates before and after launches. No build or test
from this task runs during it. Host activity and OS caches are uncontrolled.
Earlier diagnostic cohorts and weaker probe versions are excluded. All final
samples are retained, rather than selecting the fastest launches.

## Regression evidence

`tests/next-startup-route-loading-real-path.test.ts` builds a small production
App Router fixture using the shipped startup policy and launches the real Next
CLI. An observer delegates to Next's original preload method and persists a
startup receipt. Before the fix it records one startup preload; after the fix
it records none. The unrelated route still imports exactly once on its first
request and returns its real response. Observing the constructor avoids racing
background imports against a fast fixture's health response.

The native trace separately checks that the median saved tab-state request starts
within 1,000 ms of dashboard hydration. Before moving the workspace import,
the measured delays were 1,618, 1,508 and 2,068 ms, failing that assertion.
Existing saved-layout tests retain their simulated workspace boundary and
assert that unverified repository scopes cannot mount or launch it.

After the import change, that relative request time is -91, -74 and -83 ms
(median -83 ms): the request now starts before the hydration marker. The same
1,000 ms assertion passes. All six launches also prove unobscured controlled
input and a cleared draft.
