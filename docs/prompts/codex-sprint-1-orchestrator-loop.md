# Codex Sprint 1: Close the Orchestrator Loop

**Model**: GPT-5.4 xhigh reasoning
**Repo**: `~/o8`
**Branch**: `main` (all work on main, no feature branches)

---

## Mission

You are implementing the core orchestrator loop for o8 — a Next.js 16 + Tauri v2 desktop app that governs autonomous engineering teams. Claude is the orchestrator brain; Codex is the workhorse. Your job is to close the loop: **task → dispatch → execute → supervise → review → merge.**

Five issues, executed in dependency order. Each must pass `npx tsc --noEmit` before moving to the next.

---

## Codebase Rules (MANDATORY)

- **Inline styles only** — never CSS classes (`style={{ }}` props). iOS Safari constraint. Permanent.
- **All imports use `@/*` path aliases** — maps to `./src/*`
- **Never put early `return null` before hooks** — all hooks must run in same order every render
- **Never use CSS shorthand** — `paddingTop`/`paddingLeft`, not `padding: "8px 16px"`
- **Console logging prefix**: `[feature-name]` (e.g., `[dispatch]`, `[supervisor]`)
- **Commit prefix**: `feat:`, `fix:`, `refactor:`
- **Never throw in API routes** — return structured error responses
- **`as React.CSSProperties`** when using vendor-prefixed CSS props
- **TypeScript strict mode** — no `any` unless absolutely necessary
- **Verify with `npx tsc --noEmit` after each issue** (pre-existing e2e/playwright errors are OK to ignore)

---

## Architecture Context

### Runtime Adapter System (`src/lib/runtimes/`)
- `types.ts` — `AgentRuntime` interface with `discover`, `launch`, `resume`, `interrupt`, `readTranscript`
- `registry.ts` — `registerRuntime()`, `getRuntime()`, `discoverAllSessions()`, `routeAction()`
- `codex.ts` — Codex adapter. `launch()` calls `launchOwnedCodexSession()`. Functional.
- `claude-code.ts` — Claude Code adapter. `launch()` spawns via tmux. Functional.
- `index.ts` — auto-registers Codex + Claude Code (OpenClaw removed)

### Lane Command Bus (`src/lib/lane/commands.ts`)
This is the SINGLE ENTRY POINT for all lane operations. Never call runtime adapters directly.
- Verbs: `open_lane`, `launch_session`, `pause`, `resume`, `interrupt`, `create_pr`, `merge`, `release`, `close`
- Each verb evaluates policy via `evaluatePolicy()` before executing
- `create_pr` and `merge` already create approvals with continuations — FULLY IMPLEMENTED

### Orchestrator (`src/lib/orchestrator/`)
- `types.ts` — `OrchestratorPacket`, `OrchestratorMissionState`, `OrchestratorLaneBinding`
- `store.ts` — `updateOrchestratorMissionState()`, `reconcileOrchestratorMissionState()`, `packetReleaseBlockedBy()`
- Packets have: `id`, `title`, `prompt`, `runtime`, `status`, `queueState`, `workspaceTargetPath`, `dependencyPacketIds`

### Supervisor (`src/lib/supervisor/agent-supervisor.ts`)
- Polls fleet status, detects completion/stuck/retry
- `SupervisorCallbacks` interface for dependency-free event broadcasting
- `COMPLETION_CONFIRM_MS` — 15s grace period before confirming completion
- Calls `callbacks.queueOrchestratorEscalation()` on events

### Approvals (`src/lib/approvals/`)
- `types.ts` — `Approval`, `ApprovalDiffPreview`, `LaneApprovalContinuation`
- `store.ts` — `createApproval()`, `resolveApproval()`
- `policies.ts` — `evaluatePolicy()`, `buildPolicyContext()`, 12 rules across 3 risk tiers
- `llm.ts` — LLM-assisted approval evaluation

### ThoughtsCard (`src/components/desktop/thoughts/`)
- `ThoughtsChatPanel.tsx` — chat input with send action
- `ThoughtsMissionPanel.tsx` — packet list with launch buttons
- `ThoughtsCard.tsx` — container, manages `onLaunchPacket` prop
- `utils.ts` — `createDraftPacket()`, `packetTitleFromPrompt()`
- `types.ts` — `FleetAgent`, `AgentTarget`

### Auto-Review (`src/lib/lane/auto-review.ts`)
- `triggerAutoReview(lane)` — NOT auto-triggered by status changes, must be called explicitly
- `getDiffSummary(lane)` — generates git diff output

### WebSocket Server (`src/ws-server.ts`)
- Separate process on port 3002
- Wires supervisor callbacks
- Bridges mobile clients to Next.js API

---

## Issues — Execute in This Order

### GROUP 1 (parallel, no dependencies)

---

### Issue #309: Server-side packet auto-dispatch loop

**New file**: `src/lib/orchestrator/dispatch.ts`

```typescript
import type { OrchestratorMissionState, OrchestratorPacket } from './types';

/**
 * Check if a packet can be dispatched.
 * Returns null if dispatchable, or a string reason if blocked.
 */
export function getDispatchBlocker(
  packet: OrchestratorPacket,
  allPackets: OrchestratorPacket[]
): string | null

/**
 * Run one dispatch tick. For each queued packet with no blockers and no lane binding,
 * dispatch via the lane command bus.
 * Returns the updated mission state.
 */
export async function runDispatchTick(
  state: OrchestratorMissionState
): Promise<OrchestratorMissionState>
```

**Logic for `getDispatchBlocker`**:
1. If `packet.queueState !== 'queued'` → "Not queued"
2. If `packet.status !== 'queued'` → "Status is {status}"
3. Call `packetReleaseBlockedBy(packet, allPackets)` — if non-null → "Blocked by {id}"
4. If `packet.workspaceTargetPath` is null/undefined → "No workspace target"
5. If packet already has a lane binding → "Already dispatched"
6. Return null (dispatchable)

**Logic for `runDispatchTick`**:
1. For each packet in `state.packets` where `getDispatchBlocker(packet, state.packets) === null`:
2. Import and call the lane command bus dispatch functions
3. Open a lane: `dispatch({ verb: 'open_lane', packetId: packet.id, repoPath: packet.workspaceTargetPath, runtime: packet.runtime })`
4. Launch session: `dispatch({ verb: 'launch_session', laneId, prompt: packet.prompt })`
5. Update packet status to `launching` in the returned state
6. Log: `[dispatch] Dispatching packet ${packet.id}: ${packet.title}`
7. Catch errors per-packet (don't let one failed dispatch block others): set status to `blocked` with error reason

**Integration point**: Call `runDispatchTick()` inside the existing reconciliation path. Find where `reconcileOrchestratorMissionState()` is called (likely in an API route or ws-server tick) and add the dispatch tick after reconciliation.

**Acceptance criteria**:
- [ ] Queued packet with no blockers auto-launches within one reconciliation cycle
- [ ] Blocked packets stay blocked with reason
- [ ] Already-dispatched packets are skipped
- [ ] Errors on one packet don't crash others
- [ ] `npx tsc --noEmit` passes

---

### Issue #312: One-shot "send task" from ThoughtsCard chat

**File to modify**: `src/components/desktop/thoughts/ThoughtsChatPanel.tsx`

Add a "Send as Task" button next to the existing send button in the chat input area.

**On click**:
```typescript
const packet = createDraftPacket({
  title: packetTitleFromPrompt(inputText),
  prompt: inputText,
  runtime: 'codex', // default to Codex as workhorse
  queueState: 'queued',
});
onLaunchPacket(packet);
setInputText(''); // clear input
```

**UI**: A secondary button with a rocket/send icon, styled as a subtle alternative to the primary chat send. Use inline styles. 44px minimum touch target. Muted color when idle, accent color on hover.

**Props**: Verify `onLaunchPacket` is threaded through from `ThoughtsCard.tsx`. If not, add it to the props interface and thread it from the parent.

**Acceptance criteria**:
- [ ] Button visible next to send in ThoughtsCard chat
- [ ] Click creates packet and dispatches (visible in Mission panel)
- [ ] Input clears after send
- [ ] Normal chat send unchanged
- [ ] Inline styles only, 44px touch target
- [ ] `npx tsc --noEmit` passes

---

### Issue #314: Claude Code PreToolUse hook script

**New file**: `src/lib/hooks/claude-code-pretool-hook.ts`

This is a **standalone Node.js script**, NOT a module imported by the Next.js app. It runs as a shell command invoked by Claude Code's hook system.

**Protocol** (from Claude Code leaked source):
- Claude Code pipes `PreToolUseHookInput` as JSON to stdin
- Hook returns JSON on stdout with decision

**Input shape**:
```typescript
interface PreToolUseHookInput {
  session_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id: string;
}
```

**Output shape**:
```typescript
interface PreToolUseHookOutput {
  decision: 'approve' | 'block' | 'ask_user';
  reason?: string;
}
```

**Logic**:
1. Read all of stdin, parse as JSON
2. Map tool_name + tool_input to a risk assessment:
   - `Bash` with destructive commands (rm, kill, drop, truncate, format): → `block` with reason
   - `Bash` with git push/merge/rebase: → `ask_user` with reason
   - `FileWrite`/`FileEdit` to protected paths (.env, credentials, .git/): → `block`
   - Everything else: → `approve`
3. For blocked/ask decisions, attempt to POST an approval to o8's API at `http://localhost:3001/api/panel/approvals` (best-effort, don't fail if o8 isn't running)
4. Write JSON output to stdout
5. Exit 0 for approve, exit 2 for block (Claude Code convention)

**Also create**: `src/lib/hooks/install-hooks.ts` — a helper that generates the `.claude/settings.json` hooks entry pointing to this script. This is called during setup/onboarding.

**Acceptance criteria**:
- [ ] `node dist/hooks/claude-code-pretool-hook.js` reads stdin JSON, writes stdout JSON
- [ ] `rm -rf /` input → exit 2, `{ decision: "block", reason: "Destructive command blocked by o8 policy" }`
- [ ] `cat file.txt` input → exit 0, `{ decision: "approve" }`
- [ ] `git push --force` input → exit 0, `{ decision: "ask_user", reason: "Force push requires confirmation" }`
- [ ] Works standalone without Next.js server running
- [ ] `npx tsc --noEmit` passes

---

### GROUP 2 (after #309)

---

### Issue #310: Supervisor completion triggers packet state transition

**Files to modify**:
1. `src/lib/supervisor/agent-supervisor.ts` — add callback to interface, fire on completion
2. `src/ws-server.ts` — implement callback, wire lane lookup

**Step 1**: Extend `SupervisorCallbacks` interface in agent-supervisor.ts:
```typescript
interface SupervisorCallbacks {
  // ... existing callbacks ...
  onAgentCompletion?: (surfaceId: string, outcome: 'completed' | 'failed') => void;
}
```

Make it optional so existing call sites don't break.

**Step 2**: In the supervisor's completion handler (where `COMPLETION_CONFIRM_MS` grace period resolves and status is confirmed as finished), call:
```typescript
callbacks.onAgentCompletion?.(watched.surfaceId, 'completed');
```

On failure (retry exhaustion), call:
```typescript
callbacks.onAgentCompletion?.(watched.surfaceId, 'failed');
```

**Step 3**: In `ws-server.ts` where supervisor callbacks are wired, implement `onAgentCompletion`:
```typescript
onAgentCompletion: (surfaceId, outcome) => {
  // 1. Look up lane by surfaceId → sessionKey mapping
  // 2. If lane has packetId:
  //    - If outcome === 'completed': transition lane to 'reviewing'
  //    - If outcome === 'failed': transition lane to 'awaiting_input'
  // 3. If completed, call triggerAutoReview(lane) explicitly
  // 4. Log: [supervisor] Agent ${surfaceId} ${outcome}, lane → reviewing
}
```

**CRITICAL**: Do NOT import lane modules into agent-supervisor.ts. The supervisor is dependency-free by design. All lane logic goes in the callback implementation in ws-server.ts.

**Acceptance criteria**:
- [ ] Supervisor completion (after 15s grace) → lane transitions to `reviewing`
- [ ] `triggerAutoReview()` called explicitly on completion
- [ ] Supervisor failure → lane transitions to `awaiting_input`
- [ ] No lane module imports in agent-supervisor.ts
- [ ] `npx tsc --noEmit` passes

---

### GROUP 3 (after #310)

---

### Issue #315: Codex review gate with structured diff

**Files to modify**:
1. `src/lib/approvals/types.ts` — extend `ApprovalDiffPreview`
2. `src/lib/lane/commands.ts` — attach diff when creating approval in `create_pr`/`merge`
3. **New file**: `src/lib/worktree/diff-parser.ts` — parse unified diff into per-file entries

**Step 1**: Extend `ApprovalDiffPreview`:
```typescript
export interface ApprovalDiffPreview {
  before?: string;
  after?: string;
  path?: string;
  files?: Array<{
    path: string;
    status: 'A' | 'M' | 'D' | 'R';
    patch: string;
  }>;
}
```

**Step 2**: Create `src/lib/worktree/diff-parser.ts`:
```typescript
export interface DiffFile {
  path: string;
  status: 'A' | 'M' | 'D' | 'R';
  patch: string;
}

/**
 * Parse a unified git diff output into per-file entries.
 */
export function parseGitDiff(rawDiff: string): DiffFile[]
```

Logic: Split on `diff --git a/` boundaries. For each section, extract path from the `+++ b/` line, detect status from the diff header (new file = A, deleted file = D, rename = R, else M), capture the patch text.

**Step 3**: In `commands.ts`, find the `create_pr` and `merge` verbs. Where they call `createApproval()`, add:
```typescript
import { parseGitDiff } from '@/lib/worktree/diff-parser';

// Before creating approval, get the structured diff
const rawDiff = await getDiffForLane(lane); // use existing git diff helper
const files = parseGitDiff(rawDiff);

createApproval({
  // ... existing fields ...
  diff: {
    path: 'multi-file',
    after: rawDiff,
    files,
  },
});
```

**Acceptance criteria**:
- [ ] Approvals from lane merge/PR have `diff.files` array
- [ ] Each file entry has path, status, and patch text
- [ ] Parser handles added, modified, deleted, and renamed files
- [ ] Existing approval flows unbroken
- [ ] `npx tsc --noEmit` passes

---

## Verification Checklist (run after ALL issues)

```bash
# Type check
npx tsc --noEmit

# Build
npm run build

# Verify no OpenClaw references leaked back in
grep -ri "openclaw" src/ --include="*.ts" --include="*.tsx" | grep -v node_modules | wc -l
# Should be 0 or near-0 (comments only)

# Verify new files exist
ls src/lib/orchestrator/dispatch.ts
ls src/lib/hooks/claude-code-pretool-hook.ts
ls src/lib/worktree/diff-parser.ts
```

---

## Commit Strategy

One commit per issue, in execution order:
1. `feat: server-side packet auto-dispatch loop (#309)`
2. `feat: one-shot send-as-task from ThoughtsCard chat (#312)`
3. `feat: Claude Code PreToolUse hook script for policy enforcement (#314)`
4. `feat: supervisor completion triggers lane review transition (#310)`
5. `feat: structured multi-file diff in approval review gate (#315)`

Push after all 5 pass verification.
