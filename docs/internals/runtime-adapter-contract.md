*An AgentRuntime is o8's universal interface for a CLI-based coding agent. The control plane talks to this contract instead of branching on a vendor.*

# Runtime Adapter Contract

The adapter contract feeds the product-facing `RuntimeSurface` / `TerminalSession`
model used for launch, discovery, transcript reads, resume, interrupt, review, and
telemetry. Capabilities must stay truthful: a one-shot CLI advertises no resume,
while an interactive protocol that needs permission responses belongs on the
specialized path.

## Straightforward CLIs: one catalog entry

For a CLI with argument-based launch or resume and line, JSONL, or NDJSON output,
add one entry to `ORCHESTRATOR_RUNTIMES` in
`src/lib/orchestrator/runtime-capabilities.ts`. The runtime ID is inferred from
that object, so do not add a second union or validator list.

```ts
example: {
  label: 'Example',
  shortLabel: 'Example',
  dispatchable: true,
  requiresModel: false,
  accentColor: '#2563eb',
  binaryName: 'example',
  workerProvider: 'example',
  authHouse: 'example',
  reasoningEffort: false,
  tier: 'standard',
  description: 'Example CLI worker via JSONL output.',
  declarative: {
    launchArgs: ['run', '--json', '{{prompt}}'],
    resumeArgs: ['resume', '{{threadId}}', '{{prompt}}'],
    parserProfile: 'text',
    costFormat: 'text',
    authEnvVars: ['EXAMPLE_API_KEY'],
    authPaths: ['.config/example/auth.json'],
    authFix: 'Install Example, then run `example login`.',
  },
},
```

Templates support `{{cwd}}`, `{{prompt}}`, `{{model}}`, `{{effort}}`, and
`{{threadId}}`. A null `resumeArgs` value deliberately makes the runtime
one-shot. The current parser profiles are `text`, `openhands-ndjson`, and
`qwen-stream-json`; add a reusable parser profile when a new event dialect is
needed rather than writing a vendor-specific store.

That one entry generates or feeds:

- the `OrchestratorRuntime` type and runtime-ID guards;
- dispatch validation in API, MCP, preferences, persistence, and routing;
- desktop runtime options and operator defaults;
- database enum typing;
- auth inventory and setup guidance;
- the owned-session adapter, universal `AgentRuntime`, and cost parser.

The real-process smoke matrix in
`src/lib/runtimes/declarative-workers-smoke.test.ts` must cover every declarative
entry. A resumable representative must prove launch, discovered thread ID,
resume, clean child exit, and transcript normalization through the shared
adapter.

## Specialized runtimes

Use a hand-written adapter when a CLI has stateful process control that cannot be
expressed by argv and output patterns. Pi stays specialized because its RPC
stream has bidirectional permission responses; Codex, Claude Code, Gemini,
OpenCode, Cursor, and Grok also keep protocol-specific implementations.

A specialized runtime normally needs:

1. An owned-session adapter under `src/lib/<runtime>/owned.ts` that implements
   `OwnedRuntimeAdapter` and creates a store with `createOwnedSessionStore`.
2. An `AgentRuntime` under `src/lib/runtimes/<runtime>.ts` that declares truthful
   capabilities and delegates to the owned store.
3. A cost parser when the runtime emits usable telemetry.
4. One `ORCHESTRATOR_RUNTIMES` catalog entry without a `declarative` manifest.
5. Registration in `src/lib/runtimes/index.ts`.

Runtime-specific switches are acceptable only when behavior actually diverges,
such as a resume protocol or session-key format. Labels, colors, picker options,
auth houses, validation, and runtime membership come from the catalog.

## Current runtime set

The catalog contains sixteen runtimes. Fifteen are dispatchable; `antigravity`
remains discovery-only.

- Specialized: `codex`, `claude-code`, `gemini`, `opencode`, `pi`, `cursor`, `grok`, and `prime-agent`.
- Declarative: `openhands`, `goose`, `qwen`, `qoder`, `kimi`, `aider`, and `3code`.
- Discovery-only: `antigravity`.

## Contract locations

- `src/lib/runtimes/types.ts` — universal `AgentRuntime` interface.
- `src/lib/fleet/types.ts` — product-facing runtime surface.
- `src/lib/orchestrator/runtime-capabilities.ts` — canonical runtime catalog and inferred runtime type.
- `src/lib/runtimes/declarative-workers.ts` — generated declarative registrations.
- `src/lib/runtimes/shared/owned-session` — shared owned-process lifecycle.
- `src/lib/runtimes/index.ts` — specialized runtime registration.

## Design rules

1. The UI consumes normalized runtime surfaces, not vendor protocols.
2. Capability flags describe behavior that works today.
3. Cost and lifecycle telemetry survive normalization.
4. Missing resume support is reported honestly instead of simulated.
5. A new straightforward CLI must not require scattered runtime-ID edits.
