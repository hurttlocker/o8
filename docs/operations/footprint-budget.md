# Packaged-app footprint budget

The packaged application has a versioned, repeatable resource receipt. The real WebView boot gate launches the built application with isolated ports and an isolated data directory, waits for the dashboard to hydrate, hides and verifies the main native window, allows a one-minute startup cooldown, observes the stable process set for fifteen seconds, and records physical memory, interval CPU, process churn, bundle size, and isolated state size.

The receipt is written beside the tested application as `footprint-receipt.json`. An authoritative release also stores the summary in the existing pre-ship audit record.

## Budget v1

Targets express the product goal. Regression ceilings are temporary hard stops based on the measured 0.1.716 baseline. A build may remain above a target while cleanup proceeds, but it may not become materially worse.

| Metric | Target | Regression ceiling |
|---|---:|---:|
| Installed application | 250 MiB | 250 MiB |
| Update archive | 75 MiB | 75 MiB |
| Idle physical footprint | 1 GiB | 1.5 GiB |
| Idle interval CPU, whole tree | 5% | 15% |
| Native host idle CPU | 2% | 5% |
| Application server idle CPU | 5% | 12% |
| Realtime server idle CPU | 5% | 8% |
| New WebKit helpers idle CPU | 1% | 10% |
| Idle process churn | 0 | 0 |
| Native host physical footprint | tracked within total | 640 MiB |
| Application server physical footprint | tracked within total | 512 MiB |
| Realtime server physical footprint | tracked within total | 256 MiB |
| New WebKit helpers physical footprint | tracked within total | 512 MiB |
| Persistent operator data | 1 GiB | reported separately |

The hard memory ceiling is deliberately above the product target because long-running measurements can exceed the target. Lowering the ceiling before the implementation is lighter would turn the gate into a permanent bypass request instead of a regression check. CPU is budgeted both per component and across the whole tree; the earlier 2% target describes the native host, not the sum of every application and WebKit process.

## Metric contract

- Physical memory comes from the macOS `footprint` tool, not RSS. The native host and its process descendants are included.
- WebKit helpers are reparented by the operating system. The gate snapshots WebKit helper process identities immediately before launch and attributes only helpers created afterward during the isolated run.
- CPU is the change in process CPU time divided by the fifteen-second wall-clock observation after the main window is hidden and the startup cooldown completes. It is not the lifetime average reported by `ps %cpu`.
- Process churn is any owned process identity that appears or disappears during the observation. The normalized spawns and exits per minute remain in the receipt.
- Churn diagnostics report component counts only. They do not copy process commands or local paths into the release receipt.
- A child that exits between the final process-table snapshot and its `footprint` probe is excluded from the live memory total and increments `physicalMeasurementSkippedProcessCount`. A probe error for a process that remains live still fails the gate.
- Installed size uses allocated filesystem bytes. The update archive uses its file size.
- The gate's data-directory number describes a fresh isolated launch. It must not be presented as a long-lived operator-data measurement.

Run the real gate against an existing release build:

```bash
npm run gate:webview
```

The release workflow retains its existing opt-in policy for this WebView gate. When enabled, a footprint regression fails the same real packaged-app launch before upload.

## Long-lived state

The 1 GiB persistent-data target applies to a live operator profile, not the isolated release fixture. Managed worktrees already have count and total-size retention controls. Orchestrator session homes contain recoverable caches as well as conversation history, so cleanup must distinguish the two before deleting anything. Until that recovery contract is implemented, the footprint receipt reports state size without pretending a destructive sweep is safe.
