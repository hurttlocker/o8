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

## First target

The first real adapter target is:
- **OpenClaw / ACP**

Why:
- strongest native fit with current stack
- session lifecycle already exists
- approvals, artifacts, and chat/tool surfaces already exist

## Later targets
- Codex CLI / app-server
- Claude Code
- other runtime bridges as they become useful
