# Task: Remove OpenClaw Runtime From o8

You are removing the OpenClaw agent runtime from the o8 codebase. OpenClaw was one of three agent runtimes (OpenClaw, Codex, Claude Code). We are discontinuing it. Codex and Claude Code remain as the two active runtimes.

## Rules

- Inline styles only, NO CSS classes (iOS Safari constraint)
- All imports use `@/` path aliases
- Must pass `npx tsc --noEmit` when done (pre-existing e2e/playwright errors are OK)
- Never put early `return null` before hooks — all hooks must run in same order every render
- Commit prefix: `refactor:`
- Do NOT touch `docs/`, `CLAUDE.md`, or any markdown files — those will be updated separately

## What to DELETE entirely

These directories and files exist solely for OpenClaw. Delete them:

### Directories
- `src/lib/openclaw/` — gateway client, fleet, chat, stream (5 files, ~2,800 lines)
- `src/app/api/openclaw/` — abort, fleet, history, kill-terminal, steer routes (5 files, ~250 lines)

### Files
- `src/lib/runtimes/openclaw.ts` — OpenClaw runtime adapter (146 lines)
- `src/lib/connectors/openclaw-beta.ts` — beta connector client (212 lines)
- `src/lib/connectors/openclaw-beta-server.ts` — beta connector server helpers (83 lines)
- `src/lib/mobile/openclaw.ts` — mobile OpenClaw bridge (466 lines)
- `src/lib/browser/openclaw.ts` — browser surface OpenClaw integration (79 lines)
- `src/components/mobile/hooks/useOpenClawBetaStatus.ts` — beta status hook (53 lines)

**Total: ~4,100 lines deleted.**

## What to MODIFY

### 1. Runtime Registry — `src/lib/runtimes/index.ts`
Remove the OpenClaw import and registration:
```diff
- import { openclawRuntime } from './openclaw';
  import { codexRuntime } from './codex';
  import { claudeCodeRuntime } from './claude-code';

- registerRuntime(openclawRuntime);
  registerRuntime(codexRuntime);
  registerRuntime(claudeCodeRuntime);
```

### 2. Runtime Types — `src/lib/runtimes/types.ts`
Remove `'openclaw'` from the `RuntimeId` union:
```diff
- export type RuntimeId = 'openclaw' | 'codex' | 'claude-code' | (string & {});
+ export type RuntimeId = 'codex' | 'claude-code' | (string & {});
```

### 3. Dashboard — `src/app/dashboard/page.tsx`
- Remove the `openclaw` branch from the `normalizeDetection` function (~lines 92-96)
- Remove any `runtime === 'openclaw'` conditionals (lines ~157, ~426) — these are label formatters. Delete the OpenClaw branch, keep Codex and Claude Code branches.

### 4. WebSocket Server — `src/ws-server.ts` (11 references)
This is the trickiest file. The WS server bridges mobile clients to the OpenClaw gateway (port 18789). You need to:
- Remove the OpenClaw gateway connection logic (reading `~/.openclaw/openclaw.json`, connecting to gateway WS)
- Remove `import { getMobileInboxSnapshot } from './lib/mobile/openclaw'`
- Remove `import { getSessionTranscript } from './lib/openclaw/chat'`
- Remove `import { prewarmGatewayStatusCache } from './lib/openclaw/gateway-client'`
- Replace any `getMobileInboxSnapshot` calls with a stub that returns an empty inbox: `{ sessions: [], agents: [] }`
- Replace any `getSessionTranscript` calls with a stub returning `[]`
- Remove the `prewarmGatewayStatusCache()` call
- Remove the OpenClaw config file reading at line ~132
- Remove the "skipping gateway connection" log at line ~562
- Remove OpenClaw agent filtering logic (lines ~2110-2119)
- Remove the OpenClaw session interrupt path (lines ~2214-2215)
- Clean up any dead code paths that depended on the gateway connection

### 5. Settings Tabs — `src/components/desktop/settings/`
- `shared.tsx` — Remove OpenClaw beta types, hooks (`useOpenClawBetaEnabledState`, `useOpenClawBetaStatusState`), and related imports from `@/lib/connectors/openclaw-beta`
- `GitHubTab.tsx` — Remove the `OpenClawConnectionCard` component and its rendering. This is the entire OpenClaw beta connector UI in the Settings > Connectors tab.
- `AgentsTab.tsx` — Remove any OpenClaw runtime options from the agent model/runtime picker
- `AboutTab.tsx` — Remove any OpenClaw version/status display

### 6. AgentPanel — `src/components/desktop/AgentPanel.tsx`
- Remove `openClawBetaEnabled` state and any conditional logic gated on it
- Remove OpenClaw-specific session filtering or display logic
- The fleet fetch at line ~3984 checks `openClawBetaEnabled` for interval timing — simplify to just use the WS-connected interval (60s)

### 7. AgentPanelChat — `src/components/desktop/AgentPanelChat.tsx`
- Remove OpenClaw beta conditional logic

### 8. Other files with OpenClaw references (grep for `openclaw|openClaw|OpenClaw` in these):
- `src/components/desktop/Canvas.tsx` — remove OpenClaw beta flag checks
- `src/components/desktop/RepoRegistrySection.tsx` — remove OpenClaw conditional
- `src/components/desktop/WorkspaceTerminal.tsx` — remove OpenClaw refs
- `src/components/desktop/SessionTimeline.tsx` — remove OpenClaw refs
- `src/components/desktop/AnalyticsPage.tsx` — remove OpenClaw beta refs
- `src/components/desktop/SetupWizard.tsx` — remove OpenClaw from setup detection
- `src/components/desktop/LiveOutput.tsx` — remove OpenClaw refs
- `src/lib/runtime/inventory.ts` — remove OpenClaw from inventory
- `src/lib/runtime/actions.ts` — remove OpenClaw action routing
- `src/lib/runtime/adapter.ts` — remove OpenClaw adapter
- `src/lib/runtime/ide-terminal-state.ts` — remove OpenClaw refs
- `src/lib/runtime/index.ts` — remove OpenClaw exports
- `src/lib/command-center/snapshot.ts` — remove OpenClaw from fleet snapshot
- `src/lib/demo/fleet.ts` — remove OpenClaw demo data
- `src/lib/format.ts` — remove OpenClaw label formatting
- `src/lib/mobile/index.ts` — remove OpenClaw re-exports
- `src/lib/mobile/inbox-filter.ts` — remove OpenClaw inbox filtering
- `src/lib/board/state.ts` — remove OpenClaw refs
- `src/lib/chat/sidebar-events.ts` — remove OpenClaw refs
- `src/lib/mcp/cortex-mcp-server.ts` — remove OpenClaw tools
- `src/lib/render/bootstrap.ts` — remove OpenClaw from bootstrap
- `src/lib/terminal/tab-state.ts` — remove OpenClaw refs
- `src/lib/workflows/templates/sentry-triage-pr.ts` — remove OpenClaw refs
- `src/lib/browser/types.ts` — remove OpenClaw browser surface types
- `src/lib/lane/orchestrator-session.ts` — remove OpenClaw lane handling
- `src/components/command-center-shell.tsx` — remove OpenClaw UI
- `src/components/session-operator-panel.tsx` — remove OpenClaw panel
- `src/components/landing/CortexLanding.tsx` — remove OpenClaw from landing

### 9. Mobile components with OpenClaw refs:
- `src/components/mobile-remote-shell.tsx`
- `src/components/mobile/hooks/useMobileState.ts`
- `src/components/mobile/hooks/useMobilePolling.ts`
- `src/components/mobile/hooks/useWebSocket.ts`
- `src/components/mobile/hooks/useMobileStreaming.ts`
- `src/components/mobile/controller-compose.ts`
- `src/components/mobile/controller-sync.ts`
- `src/components/mobile/SettingsView.tsx`
- `src/components/mobile/WorktreeSummary.tsx`
- `src/components/mobile/ConflictSheet.tsx`
- `src/components/mobile/LaunchSheet.tsx`
- `src/components/mobile/CostsDashboard.tsx`
- `src/components/mobile/TokenUsageSummary.tsx`
- `src/components/mobile/utils.ts`

### 10. API routes with OpenClaw refs:
- `src/app/api/panel/approvals/route.ts`
- `src/app/api/panel/repos/route.ts`
- `src/app/api/panel/status/route.ts`
- `src/app/api/panel/workspaces/route.ts`
- `src/app/api/panel/analytics/route.ts`
- `src/app/api/panel/timeline/route.ts`
- `src/app/api/panel/session-costs/route.ts`
- `src/app/api/panel/universal-search/route.ts`
- `src/app/api/panel/cortex-facts/route.ts`
- `src/app/api/runtime/launch/route.ts`
- `src/app/api/runtime/transcript/route.ts`
- `src/app/api/runtime/inventory/route.ts`
- `src/app/api/runtime/action/route.ts`
- `src/app/api/mobile/action/route.ts`
- `src/app/api/mobile/sync/route.ts`
- `src/app/api/mobile/inbox/route.ts`
- `src/app/api/mobile/history/route.ts`
- `src/app/api/mobile/stream/route.ts`
- `src/app/api/mobile/media/route.ts`
- `src/app/api/mobile/session-media/route.ts`
- `src/app/api/setup/detect/route.ts`
- `src/app/api/orchestrator/delegate/route.ts`
- `src/app/api/v2/chat/send/route.ts`
- `src/app/api/v2/cortex/action/route.ts`

## What to KEEP

- `src/lib/runtimes/types.ts` — the `AgentRuntime` interface (remove `'openclaw'` from RuntimeId union but keep the interface)
- `src/lib/runtimes/registry.ts` — the runtime registry/router (unchanged except no OpenClaw registered)
- `src/lib/runtimes/codex.ts` — Codex adapter (unchanged)
- `src/lib/runtimes/claude-code.ts` — Claude Code adapter (unchanged)
- The WS server itself (`src/ws-server.ts`) — keep it running, just remove the OpenClaw gateway bridge. Mobile clients still connect to it for Codex/Claude Code data.

## Strategy

1. Delete the dedicated OpenClaw files/directories first
2. Fix all broken imports — when you delete `src/lib/openclaw/`, dozens of files will have broken imports. Fix each one.
3. For each file with OpenClaw references, the pattern is:
   - If it's an `if (runtime === 'openclaw')` branch: delete the branch, keep the else
   - If it's an OpenClaw-specific function call: replace with a no-op or remove the call
   - If it's a type that includes `'openclaw'`: remove it from the union
   - If it's OpenClaw beta UI: delete the entire component/section
4. Run `npx tsc --noEmit` after each major batch of changes to catch cascading breaks early
5. Final verification: `npx tsc --noEmit` with zero new errors

## Total Scope

- **95 files** reference OpenClaw
- **~4,100 lines** in dedicated OpenClaw files (full delete)
- **~2,000-3,000 lines** of OpenClaw-specific code scattered across 85+ other files (surgical removal)
- Estimated total removal: **~6,000-7,000 lines**

## Verification

After all changes:
```bash
npx tsc --noEmit                    # Zero new errors
grep -ri "openclaw" src/ | wc -l    # Should be 0 (or near-0 for comments)
npm run build                        # Production build succeeds
```
