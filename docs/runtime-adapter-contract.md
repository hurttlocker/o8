*An AgentRuntime is o8's universal interface for talking to any CLI-based AI coding agent (Codex, Claude Code, Gemini, opencode, Cursor, Grok Build) — the control plane never speaks to a specific runtime directly, always through this contract.*

# Runtime Adapter Contract

This doc started with issue **#11** and now reflects the shipped
**RuntimeSurface / TerminalSession** layer from issue **#25**, with the
multi-runtime capability map introduced in Wave 2a-e (2026-04-20).

## Goal

o8 should not be trapped inside a single runtime.
The control plane needs one stable contract for:
- spawn
- attach
- steer
- stop
- telemetry
- approvals
- artifacts

That runtime contract feeds a higher-level product object:
- **RuntimeSurface / TerminalSession**

Why:
- adapters are backend integration details
- RuntimeSurface is what the UI should actually reason about when opening terminal depth, runtime watch, interrupt controls, and linked review context

---

## Adding a new runtime to o8

For a one-shot or resumable CLI with line/JSONL output, the owned-session adapter
is now one declarative registry entry. `registerDeclarativeOwnedRuntime` turns
that entry into both an `OwnedRuntimeAdapter` and a `createOwnedSessionStore`
instance:

```ts
const registration = registerDeclarativeOwnedRuntime({
  runtimeId: 'example',
  binaryName: 'example',
  launchArgs: ['run', '--json', '{{prompt}}'],
  resumeArgs: ['resume', '{{threadId}}', '{{prompt}}'],
  parseRunLog: {
    patterns: [
      { eventType: 'init', threadIdPaths: ['sessionId'] },
      { eventType: 'message', kind: 'message', textPaths: ['content'] },
      { eventType: 'done', completedTurn: true },
    ],
  },
  stderrNoise: [/harmless warning/i],
  // surface/root/label fields from OwnedRuntimeAdapter
});
```

Templates support `{{cwd}}`, `{{prompt}}`, `{{model}}`, `{{effort}}`, and
`{{threadId}}`; conditional argument groups omit optional values. Pattern rows
map JSON event types or plain-line regexes to normalized entries, thread IDs,
and completion. OpenCode is the shipped example in `src/lib/opencode/owned.ts`.

Use the specialized path below when the CLI is interactive or stateful enough
to need custom process control. Pi stays specialized because its RPC stream has
bidirectional permission responses; Codex and Claude Code also stay hand-written.
When adding a new runtime ID to the dispatch surface, keep steps 4 and 5 so the
compiler still identifies genuine runtime-specific switches.

### 1. `src/lib/<runtime>/owned.ts`

Runtime adapter defining `launchArgs`, `resumeArgs`, `parseRunLog`, `stderrNoise`.
Implements the `OwnedRuntimeAdapter` interface from
`src/lib/runtimes/shared/owned-session/types.ts`.
Creates the owned session store via `createOwnedSessionStore(adapter)` and exports
public wrappers like `launchOwned<Runtime>Session`, etc.

### 2. `src/lib/runtimes/<runtime>.ts`

Universal `AgentRuntime` implementation. Delegates to the `owned.ts` wrappers.
Declares `capabilities` + `dispatchCapability`. Size target: 300–400 LoC.

### 3. `src/lib/runtimes/<runtime>-cost-parser.ts`

`CostParser` that parses the runtime's telemetry output and maps to
`SessionCostData`. Registers itself via `registerCostParser({ runtimeId, parseFiles })`
at module load.

### 4. `src/lib/orchestrator/types.ts` — line 3

Add the literal to the union:

```ts
export type OrchestratorRuntime = 'codex' | 'claude-code' | 'gemini' | 'opencode' | '<new>';
```

Never duplicate this union elsewhere. The compile-time enumeration is the safety net.

### 5. `src/lib/orchestrator/runtime-capabilities.ts`

Add a row to `ORCHESTRATOR_RUNTIMES`:

```ts
'<new>': {
  label: 'Display Name',
  shortLabel: 'DN',
  dispatchable: true,
  requiresModel: false,
  defaultModel: '<default-model-id>',
  accentColor: '#hexcolor',
  binaryName: '<cli-binary>',
  description: 'One-line description for the launch picker tooltip.',
},
```

After this step, all UI code that reads label/color via the capability map picks up
the new runtime automatically — no other UI changes required.

### 6. `src/lib/runtimes/index.ts`

Three lines: import the adapter, import the cost parser for side-effect registration,
call `registerRuntime(<runtime>Runtime)`.

---

## Why 6 files and not more

- **Duplicate union literals were eliminated in Wave 2a-e (2026-04-20).** Any file
  that hard-codes `runtime === 'codex' ? 'Codex' : 'Claude Code'` is a bug — label and
  color come from `ORCHESTRATOR_RUNTIMES[r]`.
- **Hardcoded UI branches go through the map.** Add one map entry; every label, chip,
  tint, and description updates automatically.
- **Dispatch-logic switches stay exhaustive.** `npx tsc --noEmit` after step 4 flags
  every genuine switch that needs a new case — those are real behavioral differences
  (e.g., resume semantics, model-flag requirements), not display data.

---

## Distinguishing Problem B (map it) vs Problem C (switch it)

| Pattern | Classification | Action |
|---|---|---|
| `if (r === 'codex') return 'Codex'` | **B — label lookup** | Replace with `ORCHESTRATOR_RUNTIMES[r].label` |
| `if (r === 'codex') return '#2563eb'` | **B — color lookup** | Replace with `ORCHESTRATOR_RUNTIMES[r].accentColor` |
| `if (r === 'codex') return 'openai'` | **C — billing provider** | Keep switch; it maps runtimes to payment providers, which is real divergent logic |
| `if (r === 'codex') resumeViaThread(...)` | **C — dispatch logic** | Keep switch; each runtime has a different resume protocol |
| `if (r === 'codex' && !model) return 'strong'` | **C — tier classification** | Keep switch; default model strength differs per runtime |

---

## Current shipped status (Wave 2f)

Eight runtimes in the union (antigravity = discovery-only):
- `codex` — GPT-5.4 xhigh, `codex exec --json`, thread resume
- `claude-code` — Claude Code CLI, session resume, full tool surface
- `gemini` — Gemini CLI, `--yolo` dispatch, JSONL streaming
- `opencode` — multi-provider coding CLI, `opencode run`, requires `--model` flag
- `cursor` — Cursor CLI, `cursor-agent -p --output-format stream-json`
- `grok` — Grok Build CLI, headless JSON-schema constrained output
- `pi` — earendil-works/pi, `pi --mode rpc` bidirectional JSONL, NATIVE steer + permission-gate seam

All label, accentColor, shortLabel, description, and dispatchable data lives in
`src/lib/orchestrator/runtime-capabilities.ts`. UI must read from the map, not
inline the values.

Remaining Problem C switches (intentional, exhaustive dispatch logic):
- `src/lib/dispatch/read-budget.ts` — tier classification by runtime default model
- `src/lib/orchestrator/cost-persistence.ts:providerForRuntime` — billing provider routing
- `src/components/desktop/workspace-terminal/utils.ts` — session-key canonicalization per runtime
- `src/lib/runtime/ide-session-registry.ts` — session-key prefix logic
- `src/lib/terminal/tab-state.ts` — tab canonicalization logic
- `src/lib/lane/auto-review.ts` — review dispatch differs per runtime
- `src/lib/chat/sidebar-events.ts` — capability inference (runtime-gated feature set)

---

## Architecture context

The adapter-facing contract lives in:
- `src/lib/runtimes/types.ts` — `AgentRuntime` interface

The product-facing RuntimeSurface contract lives in:
- `src/lib/fleet/types.ts`

Capability map (add new runtimes here):
- `src/lib/orchestrator/runtime-capabilities.ts`

Runtime union (one source of truth):
- `src/lib/orchestrator/types.ts` — `OrchestratorRuntime`

Runtime registry (wires adapters to the dispatch layer):
- `src/lib/runtimes/index.ts`

## Design rules

### 1. Runtimes are adapters, not the UI model
The UI should not know runtime-vendor-specific semantics everywhere.
It should talk to a normalized contract.

### 2. Capabilities are explicit
Not every runtime supports every operation cleanly.
The adapter exposes capability flags so the UI can present only truthful controls.

### 3. Telemetry is first-class
Cost, context pressure, and state have to survive normalization.

### 4. Pause is not assumed
Different runtimes mean different semantics. If pause is not real yet, the adapter should say so instead of lying.
