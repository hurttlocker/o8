# Runtime Adapter v2 — Universal Agent Runtime Contract

> **Historical design snapshot.** This proposal predates the declarative
> runtime expansion and still names deleted files and `claude -p`. The current
> extension contract is [`runtime-adapter-contract.md`](./runtime-adapter-contract.md)
> and the registry truth is `src/lib/orchestrator/runtime-capabilities.ts`.

## Problem

Cortex IDE currently has 1,788 lines of Codex-specific code (`sessions.ts` + `owned.ts`) and 257 lines of OpenClaw-specific code (`openclaw.ts`), plus a `switch (agent.runtime)` dispatch in `actions.ts`. Adding Claude Code means either:

- **Duplicate** another ~1,500 lines (unsustainable)
- **Abstract** the common shape into a contract (one file per runtime)

## Design Principles

1. **Adding a new agent runtime = one file.** Implement the interface, register it, done.
2. **The UI never knows what runtime it's talking to.** Squad view, chat, diff, compose — all work through the contract.
3. **Capabilities are declared, not assumed.** Each runtime says what it can do. UI adapts.
4. **Discovery is local-first.** Runtimes find sessions on disk, not via cloud APIs.
5. **Progressive disclosure.** Simple runtimes can implement 3 methods. Complex ones implement 12.

## The Contract

```typescript
// src/lib/runtimes/types.ts

export type RuntimeId = 'openclaw' | 'codex' | 'claude-code' | string;

/**
 * What a runtime can do. UI uses this to show/hide controls.
 * All default to false — a runtime opts IN to capabilities.
 */
export interface RuntimeCapabilities {
  /** Can discover existing sessions on disk/network */
  discover: boolean;
  /** Can read session transcript/history */
  readTranscript: boolean;
  /** Can launch a new session with a prompt */
  launch: boolean;
  /** Can send follow-up messages to an existing session */
  resume: boolean;
  /** Can interrupt/stop a running session */
  interrupt: boolean;
  /** Can provide changed files / diff context */
  reviewDiffs: boolean;
  /** Can provide cost/token telemetry */
  costTelemetry: boolean;
  /** Supports real-time streaming of output */
  streaming: boolean;
}

/**
 * Normalized session shape. Every runtime maps its internal format to this.
 */
export interface RuntimeSession {
  /** Unique key for this session across all runtimes */
  sessionKey: string;
  /** Runtime that owns this session */
  runtimeId: RuntimeId;
  /** Human-readable name (e.g., "cortex-ide • main") */
  displayName: string;
  /** Working directory */
  cwd: string;
  /** Git branch if known */
  branch?: string;
  /** Repository slug if known (e.g., "hurttlocker/o8") */
  repoSlug?: string;
  /** Current status */
  status: 'running' | 'idle' | 'waiting' | 'reviewing' | 'failed';
  /** Ownership model */
  ownership: 'discovered' | 'owned' | 'provider';
  /** What can be done with this session right now */
  capabilities: {
    canSendInput: boolean;
    canInterrupt: boolean;
    canReviewDiffs: boolean;
  };
  /** When this session was last active */
  lastActivityAt: Date;
  /** The initial task/prompt */
  initialTask?: string;
  /** Model being used */
  model?: string;
  /** Lifecycle state for owned sessions */
  lifecycle?: {
    availability: 'awaiting-thread' | 'running' | 'ready-for-resume';
    lastOutcome?: 'finished' | 'interrupted' | 'failed';
    summary?: string;
  };
}

/**
 * Normalized transcript entry. Every runtime maps its log format to this.
 */
export interface RuntimeTranscriptEntry {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  text: string;
  timestamp: Date;
  /** Tool name if role=tool */
  toolName?: string;
  /** File path if the entry involves a file */
  filePath?: string;
}

/**
 * Changed file from a session's work.
 */
export interface RuntimeChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
}

/**
 * Result of a launch/resume/interrupt action.
 */
export interface RuntimeActionResult {
  ok: boolean;
  note: string;
  sessionKey?: string;
}

/**
 * THE CONTRACT. Every agent runtime implements this.
 *
 * Simple runtimes can throw "not supported" for optional methods.
 * The `capabilities` property tells the UI what's available.
 */
export interface AgentRuntime {
  /** Unique runtime identifier */
  readonly id: RuntimeId;
  /** Display name for UI */
  readonly displayName: string;
  /** What this runtime supports */
  readonly capabilities: RuntimeCapabilities;

  // ── Discovery ──

  /**
   * Find all sessions this runtime knows about.
   * Called on initial load and periodic refresh.
   */
  discoverSessions(): Promise<RuntimeSession[]>;

  // ── Transcript ──

  /**
   * Read transcript entries for a session.
   * @param sessionKey - The session to read
   * @param sinceId - Only return entries after this ID (for incremental fetch)
   * @param limit - Max entries to return
   */
  readTranscript(
    sessionKey: string,
    sinceId?: string,
    limit?: number,
  ): Promise<RuntimeTranscriptEntry[]>;

  // ── Lifecycle ──

  /**
   * Launch a new session with a prompt.
   * Returns the created session info.
   */
  launch(opts: {
    cwd: string;
    prompt: string;
    model?: string;
  }): Promise<RuntimeActionResult>;

  /**
   * Send a follow-up message to an existing session.
   */
  resume(sessionKey: string, message: string): Promise<RuntimeActionResult>;

  /**
   * Interrupt/stop a running session.
   */
  interrupt(sessionKey: string): Promise<RuntimeActionResult>;

  // ── Review ──

  /**
   * Get changed files from a session's work.
   */
  getChangedFiles(sessionKey: string): Promise<RuntimeChangedFile[]>;

  // ── Telemetry (optional) ──

  /**
   * Get cost/usage data for a session.
   */
  getTelemetry?(sessionKey: string): Promise<{
    totalTokens?: number;
    remainingTokens?: number;
    estimatedCostUsd?: number;
  }>;
}
```

## Registry

```typescript
// src/lib/runtimes/registry.ts

const runtimes = new Map<RuntimeId, AgentRuntime>();

export function registerRuntime(runtime: AgentRuntime): void {
  runtimes.set(runtime.id, runtime);
}

export function getRuntime(id: RuntimeId): AgentRuntime | undefined {
  return runtimes.get(id);
}

export function getAllRuntimes(): AgentRuntime[] {
  return [...runtimes.values()];
}

/**
 * Discover sessions across ALL registered runtimes.
 * This replaces the current Codex-specific + OpenClaw-specific discovery.
 */
export async function discoverAllSessions(): Promise<RuntimeSession[]> {
  const results = await Promise.allSettled(
    getAllRuntimes()
      .filter((r) => r.capabilities.discover)
      .map((r) => r.discoverSessions()),
  );
  return results
    .filter((r): r is PromiseFulfilledResult<RuntimeSession[]> => r.status === 'fulfilled')
    .flatMap((r) => r.value);
}
```

## Implementation Plan

### Phase 1: Contract + Registry (this PR)
- `src/lib/runtimes/types.ts` — The contract (above)
- `src/lib/runtimes/registry.ts` — Registration + unified discovery
- `src/lib/runtimes/openclaw.ts` — Wrap existing OpenClaw code
- `src/lib/runtimes/codex.ts` — Wrap existing Codex code
- `src/lib/runtimes/index.ts` — Barrel export + auto-registration

**No UI changes. No behavior changes.** Just introduce the abstraction and verify it produces the same fleet snapshot.

### Phase 2: Claude Code runtime
- `src/lib/runtimes/claude-code.ts` — Implement the contract for Claude Code
- Discovery: Read `~/.claude/projects/*/` JSONL files
- Transcript: Parse Claude Code's message format
- Launch: `claude -p --print --permission-mode bypassPermissions`
- Resume: `claude --resume <sessionId>`
- Review: Git diff from session's CWD

### Phase 3: Wire UI through contract
- Replace `switch (agent.runtime)` in `actions.ts` with `getRuntime(agent.runtime).resume()`
- Replace direct Codex/OpenClaw imports in inventory with `discoverAllSessions()`
- Fleet snapshot builder uses registry instead of hardcoded discovery

### Phase 4: Future runtimes (zero-effort adds)
- Aider: `src/lib/runtimes/aider.ts`
- Cursor Agent: `src/lib/runtimes/cursor.ts`
- OpenCode: `src/lib/runtimes/opencode.ts`
- Any MCP-based agent: `src/lib/runtimes/mcp.ts`

## File Layout

```
src/lib/runtimes/
├── types.ts          # Contract interfaces
├── registry.ts       # Runtime registration + unified discovery
├── index.ts          # Barrel + auto-registration
├── openclaw.ts       # OpenClaw adapter (wraps existing code)
├── codex.ts          # Codex adapter (wraps existing code)
└── claude-code.ts    # Claude Code adapter (new)
```

## Migration Strategy

Phase 1 wraps, doesn't rewrite. The existing `codex/sessions.ts` and `codex/owned.ts` stay untouched. `runtimes/codex.ts` calls into them and maps to the contract types. Same for OpenClaw.

This means zero risk of breaking existing functionality while the abstraction proves itself.

Once the abstraction is validated, Phase 3 can progressively remove the direct imports.

## Capability Matrix

| Capability | OpenClaw | Codex | Claude Code | Aider (future) |
|---|---|---|---|---|
| discover | ✅ (gateway) | ✅ (sqlite + fs) | ✅ (fs) | ✅ (fs) |
| readTranscript | ✅ (chat.history) | ✅ (JSONL) | ✅ (JSONL) | ✅ (log files) |
| launch | ❌ (mirror only) | ✅ (codex exec) | ✅ (claude -p) | ✅ (aider --message) |
| resume | ✅ (chat.send) | ✅ (codex exec resume) | ✅ (claude --resume) | ❌ |
| interrupt | ✅ (abort) | ✅ (SIGINT) | ✅ (SIGINT) | ✅ (SIGINT) |
| reviewDiffs | ✅ (gateway) | ✅ (git diff) | ✅ (git diff) | ✅ (git diff) |
| costTelemetry | ✅ (gateway) | ❌ | ❌ | ❌ |
| streaming | ✅ (WS) | ✅ (stdout) | ✅ (stream-json) | ❌ |
