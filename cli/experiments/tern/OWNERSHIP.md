# S3a: separate viewer, existing Pi owner

Test-only slice on top of the S2 lab. No production runtime,
permission bridge, renderer, dispatch or worker-input attachment is changed.

## Run from the repository root

```sh
npm ci
npm --prefix cli/experiments/tern ci --ignore-scripts
npm --prefix cli/experiments/tern run build
npx vitest run --config cli/experiments/tern/vitest.ownership.config.ts
```

The explicit config reuses o8's normal isolated data setup and aliases. The
resource-owning `.mjs` experiment is not part of the hermetic default. Its named
workflow runs the ownership cases, the real-SDK tests and the classification
check on pull requests that touch the lab, the Pi runtime or approvals; the
main CI owns typecheck, lint and the hermetic suite. Missing root dependencies
or the real SDK is a failure, not a skip.

## What the test actually drives

- Real `piRuntime.launch/resume/interrupt`, the Pi RPC process owner, the existing
  permission bridge and persisted approval/session/transcript records.
- A deterministic executable Pi protocol peer: no model or work tools.
- Separate observer processes executing the unchanged S2 `runLab` entry point
  and public Tern SDK against an independent fake terminal.
- Normal native close, failed frame transport, SIGTERM during negotiation,
  reopening the observer, and restarting the worker through its existing owner.
- Plausible TSP approve/reject/interrupt/steer/prompt actions and Ctrl-C are sent
  only to the observer's terminal input. No worker control channel is passed.
- Pending approval identity/audit, worker PID, inbound RPC bytes, active-run
  identity and normalized transcript entries remain unchanged by the observer.
- Explicit approval denial/acceptance and interruption still work through o8.
  Worker restart reuses its session file and retains each prior transcript ID once.

The observer's read adapter is injected with an envelope built from actual owned
runtime records. This does **not** verify an installed `o8 packet info` command,
CLI authentication, mission/packet dispatch, a real Pi/OMP provider, native Tern
appearance, a PTY/daemon, or cross-runtime continuity. No release is implied.

## Evidence

Local Node 22.16.0: syntax checks passed; the scripted Pi executable passed six
protocol/lifecycle assertions (version, pending/silent state, denial, approval,
and durable restart). These are fixture checks only. The full owning-runtime
and SDK execution must be read from the new exact-head workflow, not inherited
from the S2 lab's own receipt.

## Authority

The existing o8 Pi runtime and permission bridge remain authoritative; the test
reuses their public entry points rather than introducing another controller.
The gate itself is defined in #3365.
