# Mobile/Desktop Orchestrator Chat Parity Plan

Last updated: 2026-05-25

## Scope

Make the native Expo app in `~/o8-mobile` and the desktop o8 app in `~/o8` share one built-in o8/Claude orchestrator chat identity.

OpenClaw is explicitly out of scope for this plan. Treat OpenClaw as beta-side work and do not add OpenClaw-specific behavior here.

## Goal

Desktop and mobile should use the same orchestrator conversation:

- Same `thoughts-*` thread id
- Same `repoPath`
- Same `~/.o8/chat-history/<threadId>.json` file
- Same transcript
- Same normal o8/Claude orchestrator backend
- Mobile-started chats appear on desktop
- Desktop-started chats appear on mobile

## Current State

- Desktop o8 is live through the Next backend, currently observed on `localhost:3010`.
- The WS bridge is live, currently observed on `localhost:3002`.
- Mobile/serve-sim is live through Metro at `http://localhost:8081/.sim`.
- Mobile already reads the desktop runtime inbox and sees `cortex-ide` sessions.
- Mobile loads orchestrator threads from `GET /api/mobile/orchestrator/threads`.
- Mobile chat already subscribes/sends over WS by `repoPath`.
- Mobile chat already loads/persists transcript data by `tabId` through `/api/v2/chat-history`.
- Gap: mobile can still mint local `thoughts-...-mobile` ids. Those land in the shared namespace eventually, but desktop does not own the thread identity from the first click.

## Execution Plan

1. Extract shared desktop thread helpers in `cortex-ide`.

   Create a canonical helper under `src/lib/orchestrator` or a nearby existing domain module for:

   - safe `thoughts-*` thread id minting
   - reading `~/.o8/chat-history`
   - projecting `MobileOrchestratorThread`
   - creating metadata-only placeholder records
   - preserving repo metadata

   This should reduce duplication between `src/app/api/mobile/orchestrator/threads/route.ts` and `src/app/api/v2/chat-history/route.ts`.

2. Add desktop-owned mobile thread creation.

   Add `POST /api/mobile/orchestrator/threads`.

   Request shape:

   ```json
   {
     "repoPath": "/workspace/o8",
     "title": "New conversation",
     "runtime": "claude-code"
   }
   ```

   Response shape:

   ```json
   {
     "thread": {
       "id": "thoughts-...",
       "repoPath": "/workspace/o8",
       "title": "New conversation",
       "runtime": "claude-code",
       "status": "idle",
       "messageCount": 0
     }
   }
   ```

   The endpoint must mint the id on desktop, write the placeholder history record, and return the canonical thread. Do not make mobile invent this id.

3. Add desktop reveal/open behavior.

   Add a desktop-side contract so mobile can ask desktop to reveal a thread:

   - Preferred: `POST /api/mobile/orchestrator/threads/:id/reveal`
   - Acceptable: a WS event such as `desktop-open-orchestrator-thread`

   The implementation should reuse the existing desktop workspace/orchestrator tab path. Do not introduce a second desktop chat concept.

4. Update `o8-mobile` to use desktop-owned ids.

   In `~/o8-mobile`:

   - Add a client helper such as `createOrchestratorThread(config, input)` in `src/o8/orchestrator.ts`.
   - Update new-chat flow to call the desktop endpoint.
   - Remove local `thoughts-${Date.now()}-mobile...` id creation.
   - Navigate with the returned `thread.id` and `thread.repoPath`.
   - Keep the existing WS send path keyed by `repoPath`.
   - Keep transcript persistence keyed by `tabId`.

5. Add sync/refresh behavior.

   Minimum viable sync:

   - after mobile creates a thread, refetch `GET /api/mobile/orchestrator/threads`
   - after mobile sends and receives ready status, persist transcript and refetch
   - after desktop renames/archives/sends, keep existing `o8:chat-history-updated` behavior intact

   Better sync:

   - broadcast `orchestrator-thread-updated` or equivalent over WS
   - mobile selector/chat listens and refreshes active/list state

6. Verify parity.

   Required smoke checks:

   - Desktop-created chat appears on mobile with the same `thoughts-*` id.
   - Mobile-created chat appears on desktop with the same `thoughts-*` id.
   - Mobile send writes to the same desktop chat-history file.
   - Desktop continuation is visible on mobile after reload/refetch.
   - `repoPath` remains the desktop repository's canonical absolute path.
   - No OpenClaw-specific route or backend is used.

## Files To Inspect First

Desktop repo: `~/o8`

- `src/app/api/mobile/orchestrator/threads/route.ts`
- `src/app/api/v2/chat-history/route.ts`
- `src/app/api/v2/chat-history/list/route.ts`
- `src/ws-server.ts`
- `src/app/dashboard/page.tsx`
- `src/components/desktop/workspace-terminal/OrchestratorTab.tsx`
- `src/components/desktop/workspace-terminal/terminal-tab-handlers.ts`

Mobile repo: `~/o8-mobile`

- `src/o8/orchestrator.ts`
- `src/o8/ws.ts`
- `src/o8/types.ts`
- `src/app/chat.tsx`
- `src/components/orchestrator-selector.tsx`

## Verification Commands

Desktop/live endpoints:

```bash
TOKEN="$(tr -d '\n' < "$HOME/.o8/ws-token")"
curl -fsS -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3010/api/mobile/orchestrator/threads"
curl -fsS -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3010/api/mobile/inbox"
```

Mobile app:

```bash
cd ~/o8-mobile
npx tsc --noEmit
bun run lint
bun start -- --dev-client --host lan --port 8081
bun run sim:list
```

Desktop app:

```bash
cd ~/o8
npm run lint
npm run typecheck
```

## Resume Prompt For Agent After Compaction

You are in `~/o8`. Continue the mobile/desktop orchestrator chat parity work described in `docs/mobile-desktop-chat-parity-plan.md`. The goal is to make the built-in o8/Claude orchestrator share exact chat identity between desktop and `~/o8-mobile`: same `thoughts-*` id, same `repoPath`, same `~/.o8/chat-history/<threadId>.json`, same transcript, and visible on both clients. Do not work on OpenClaw in this plan.

Start by implementing the desktop side in `o8`: extract shared chat-history/thread helpers if useful, add `POST /api/mobile/orchestrator/threads` so desktop mints canonical `thoughts-*` ids and writes metadata-only placeholder records, then add a reveal/open contract so mobile-created threads can be opened or focused in the desktop orchestrator tab. After desktop works, update `~/o8-mobile` so mobile no longer creates `thoughts-...-mobile` ids locally and instead calls the desktop creation endpoint before navigating to `/chat`.

Use the currently running surfaces when available: desktop backend `localhost:3010`, WS `localhost:3002`, mobile serve-sim `http://localhost:8081/.sim`. Verify with real API calls and at least one desktop-started and one mobile-started chat. Run typecheck/lint in each repo you modify. Keep commits scoped per repo.
