# Runtime Adapter Contract

This doc is the first implementation pass for issue **#11**.

## Goal

Cortex IDE should not be trapped inside a single runtime.
The control plane needs one stable contract for:
- spawn
- attach
- steer
- stop
- telemetry
- approvals
- artifacts

That runtime contract should now be thought of as feeding a higher-level product object:
- **RuntimeSurface / TerminalSession**

Why:
- adapters are backend integration details
- RuntimeSurface is what the UI should actually reason about when opening terminal depth, runtime watch, interrupt controls, and linked review context

## Current implementation surface

The draft TypeScript contract lives in:
- `src/lib/runtime/adapter.ts`

## Design rules

### 1. Runtimes are adapters, not the UI model
The UI should not know OpenClaw-specific or Codex-specific semantics everywhere.
It should talk to a normalized contract.

### 2. Capabilities are explicit
Not every runtime supports every operation cleanly.
The adapter exposes capability flags so the UI can present only truthful controls.

### 3. Telemetry is first-class
Karpathy explicitly called out usage/stats. Cost, context pressure, and state have to survive normalization.

### 4. Pause is not assumed
Different runtimes mean different semantics. If pause is not real yet, the adapter should say so instead of lying.

## Draft contract surface

### Required methods
- `spawn(request)`
- `attach(sessionKey)`
- `steer(runId, instruction)`
- `pause(runId)`
- `stop(runId)`
- `getTelemetry(runId)`

### Required capability categories
- spawn / attach / steer / pause / stop
- terminal / diff / artifacts
- approvals
- memory context
- cost telemetry

### Product-facing outcome
The adapter layer should be able to populate a truthful RuntimeSurface that includes:
- identity (`id`, `runtime`, `title`, `cwd`, `branch` when available)
- state (`running`, `idle`, `blocked`, `exited`, `unknown`)
- explicit capabilities (`attach`, `readTail`, `sendInput`, `interrupt`, `resize`, `diffContext`, `reviewContext`)
- linked review context (repo / PR / branch / artifacts)

The UI should present runtime depth from this product-facing surface rather than hard-coding vendor-specific assumptions into every view.

## First target

The first real adapter target is:
- **OpenClaw / ACP**

Why:
- strongest native fit with current stack
- session lifecycle already exists
- approvals, artifacts, and chat/tool surfaces already exist

## Current MVP status

The live bridge MVP now wires the first truthful operator actions through the OpenClaw gateway:
- `chat.history` for sanitized transcript / session-log viewing
- `chat.send` for explicit steer actions on an existing session
- `chat.abort` for explicit interrupt / stop actions on an existing session

Important truth guardrail:
- **spawn is still intentionally disabled in the live bridge UI**
- the shell mirrors existing sessions first and only adds runtime control where it is semantically honest

## Later targets
- Codex CLI / app-server
- Claude Code
- other runtime bridges as they become useful
