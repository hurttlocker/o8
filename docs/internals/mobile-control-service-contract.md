# Mobile Control Service Contract

Issue: #17

## Purpose

This contract keeps the phone surface speaking to **Cortex IDE**, not directly to any one runtime.

The mobile app should never need to know whether the backing run is:
- OpenClaw
- ACP
- Codex
- Claude Code
- something else later

That translation belongs in the desktop/server-side control plane.

## Design rule

**Desktop is the heavy execution surface.**  
**Mobile is the remote operator surface.**

So the mobile contract optimizes for:
- inspect
- approve / deny
- steer
- pause / resume / stop
- review-ready awareness
- run-watch summaries
- deep-link to desktop when needed

## Core entities

### Session handle
A stable reference to an operator-visible runtime session.

```ts
interface MobileSessionHandle {
  id: string;
  sessionKey: string;
  runtime: string;
  title: string;
  status: 'idle' | 'running' | 'blocked' | 'reviewing' | 'waiting' | 'failed';
  currentTask: string;
  isPrimary?: boolean;
  isCurrentSession?: boolean;
}
```

### Inbox item
A mobile-optimized unit of attention.

```ts
interface MobileInboxItem {
  id: string;
  kind: 'alert' | 'approval' | 'review' | 'run_watch';
  severity: 'info' | 'success' | 'warning' | 'critical';
  title: string;
  detail: string;
  sessionKey?: string;
  timestampLabel?: string;
  actions: MobileControlAction[];
}
```

### Action
A provider-agnostic operator action.

```ts
interface MobileControlAction {
  kind:
    | 'inspect'
    | 'steer'
    | 'approve'
    | 'deny'
    | 'pause'
    | 'resume'
    | 'stop'
    | 'open_review'
    | 'open_desktop';
  label: string;
  sessionKey?: string;
  href?: string;
  destructive?: boolean;
  available: boolean;
  reasonUnavailable?: string;
}
```

## Required control-service endpoints

### 1. Inbox snapshot
Returns the current mobile-safe operator view.

```ts
GET /api/mobile/inbox
```

Returns:
- primary mirrored session
- visible sessions
- inbox items
- summary counts
- provider-safe note about what is live vs unavailable

### 2. Inspect history
Returns a concise session transcript / event tail.

```ts
GET /api/mobile/history?sessionKey=...
```

### 3. Action dispatch
Handles provider mapping centrally.

```ts
POST /api/mobile/action
{
  action: 'steer' | 'stop' | 'approve' | 'deny' | 'pause' | 'resume',
  sessionKey: string,
  payload?: object
}
```

## Adapter mapping rule

The control service owns provider translation.

Examples:
- OpenClaw `steer` -> `chat.send`
- OpenClaw `stop` -> `chat.abort`
- OpenClaw approval actions -> unsupported until a truthful approval primitive exists
- Review-ready item -> maps to repo/worktree/PR review snapshot, not runtime transport directly

## Truthfulness rule

The contract must distinguish between:
- **available now**
- **planned but not wired**

No fake actions.
No demo buttons pretending to work.

## First backing adapter

### OpenClaw-backed v1
The first real adapter should provide:
- inspect current mirrored sessions
- steer session
- stop active run
- review-ready summary from Git / GitHub / worktree lane
- live mirrored-session-first behavior

That is enough to make mobile real without pretending it already has full approval orchestration.

## Non-goals for v1

- full repo editing on phone
- giant file tree navigation
- branch surgery as a primary job
- runtime-specific UI branching in the mobile client

## Product outcome

If this contract is right, the phone becomes:
- a real operator inbox
- a blocker/approval surface
- a run-watch remote
- a lightweight review monitor

And the desktop remains:
- execution-heavy
- context-heavy
- review-heavy
