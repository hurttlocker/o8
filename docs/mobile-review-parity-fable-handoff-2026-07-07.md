# Mobile Review Parity Handoff for Fable

Date: 2026-07-07  
Repos: desktop `~/o8`, mobile `~/o8-mobile`

## Goal

Make the mobile Review surface truthful and parity-grade with the desktop review
surface. The phone must distinguish three states:

1. No review work exists.
2. Review work is inspectable, but not attached to an approval gate.
3. A real approval gate exists and can be approved, sent back, or denied from mobile.

The mobile side is being patched to stop calling state 2 "All caught up". The
desktop still needs to send one canonical reviewable unit for state 3.

## Current Live Mismatch

Observed against the running desktop app on 2026-07-07:

- `GET /api/mobile/inbox` returned `approvals: []`.
- The same snapshot had one Codex owned session with `status: "reviewing"`:
  `codex-owned:codex-owned-1783391354708-83658dcb`.
- `GET /api/worktrees/diff?sessionKey=codex-owned%3Acodex-owned-1783391354708-83658dcb`
  returned a real worktree diff: 6 files, +131, -13.
- The desktop also emitted `items[]` entry `review:unknown` with
  `unknown - 0 changed files`, and top-level `review` reported:
  `repoSlug: ""`, `branch: "unknown"`, `changedFiles: []`,
  `diffStat: "Working tree clean."`.

Mobile consequence before the patch:

- `/approvals` said "All caught up".
- `/diffs` showed the real session diff.
- Fleet was mostly truthful because it only marks `awaiting_review` when an
  approval card exists.
- The foreground status rail was less strict and treated raw `reviewing` as
  `awaiting_review`.

## Desktop Source Files to Start From

- `src/lib/mobile/inbox.ts`
  - Builds `sessions`, `approvals`, `items`, `summary`, and top-level `review`.
  - `pendingApprovals = listApprovals({ status: 'pending' })` is the current
    only source for mobile approval cards.
  - Always adds workspace review snapshot item if `getWorkspaceReviewSnapshot`
    returns, even when it is clean/unknown.

- `src/lib/approvals/store.ts`
  - `toMobileApprovalCard` is the authoritative approval-card projection.

- `src/app/api/mobile/action/route.ts`
  - `approve` / `request_changes` / `deny` addressing is fail-closed and
    `approvalId`-authoritative (hardened for punchlist Option B):
    - When `approvalId` is present it is AUTHORITATIVE — the card is resolved
      directly and the route NEVER falls back to the `sessionKey` lookup. A
      stale/recycled/mismatched `sessionKey` sent alongside a valid `approvalId`
      is ignored for addressing (logged `[mobile-action]`), so it can no longer
      mis-target a different pending card's merge. A missing card returns
      `409 {ok:false,error:'approval_not_found'}`; an already-resolved card
      returns `410 {ok:false,error:'approval_resolved'}` (nothing mutated).
    - When `approvalId` is absent (old clients) the legacy `sessionKey`→pending
      lookup is kept as-is, with one guard: >1 pending card for the session
      returns `409 {ok:false,error:'ambiguous_approval',approvalIds:[...]}`
      instead of guessing, so a newer client can re-issue addressed to the id it
      means. Exactly one pending still resolves; zero still 404s.

- `src/app/api/worktrees/diff/route.ts`
  - Mobile can inspect live diffs by `sessionKey`.
  - This endpoint is not sufficient for approval authority.

- `src/lib/review/workspace.ts`
  - Returns clean workspace snapshots as normal review snapshots.
  - That is how `review:unknown` / `Working tree clean.` leaks into mobile.

## Contract Mobile Needs

Add an explicit review-unit projection to `/api/mobile/inbox`. Do not make
mobile infer authority from a runtime `status: "reviewing"` string.

Recommended shape:

```ts
interface MobileReviewUnit {
  id: string;
  sessionKey: string;
  approvalId?: string;
  authority: 'approval_gate' | 'inspect_only';
  status: 'awaiting_review' | 'running' | 'blocked' | 'failed' | 'merged' | 'stale';
  title: string;
  agent: string;
  runtime: string;
  repo: string;
  repoSlug?: string;
  repoPath: string;
  branch: string;
  baseBranch?: string;
  baseSha?: string;
  headSha?: string;
  worktreePath?: string;
  changedFiles: Array<{
    path: string;
    status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
    additions?: number | null;
    deletions?: number | null;
  }>;
  fileCount: number;
  additions: number;
  deletions: number;
  diffAvailable: boolean;
  previewUrl?: string | null;
  terminalSessionName?: string | null;
  actions: Array<'inspect' | 'comment' | 'approve' | 'request_changes' | 'deny' | 'steer' | 'stop'>;
  staleReason?: string;
}
```

Then either:

- add `reviewUnits: MobileReviewUnit[]` as a new top-level array, or
- replace the current ambiguous top-level `review` object with this model.

Keep `approvals[]` for backward compatibility until mobile migrates fully, but
make every approval-backed review unit include `approvalId`.

## Required Desktop Fixes

1. Stop emitting `review:unknown` as an actionable review item.
   - If `repoSlug` is empty, branch is `unknown`, no PR exists, and
     `changedFiles.length === 0`, omit the `review` item from `items[]`.
   - If the clean workspace snapshot is still useful, label it as non-actionable
     desktop context, not a review item.

2. Promote owned Codex review sessions into review units.
   - If a runtime session is `status: "reviewing"` and has a lane/worktree diff,
     emit an `inspect_only` review unit even without an approval record.
   - Include `sessionKey`, repo path, branch, diff stats, file list, and
     `diffAvailable: true`.

3. Create real approval records when desktop expects mobile approval authority.
   - If the desktop UI would show approve/request-changes/deny, mobile needs
     `approvalId`.
   - Do not ask mobile to approve session-only review rows.

4. Make summary counts match authority.
   - `summary.approvals`: count pending approval gates.
   - `summary.reviewItems`: count concrete review units, not clean/unknown
     workspace snapshots.
   - Consider adding `summary.inspectOnlyReviews` if the product wants that
     number visible.

5. Put the same metadata in `items[]` and `approvals[]`.
   - At minimum: `repo`, `repoPath`, `repoSlug`, `branch`, `changedFilePaths`,
     `filesChanged`, `additions`, `deletions`, `previewUrl`, `terminalSessionName`,
     `approvalId`.

6. Keep `/api/mobile/action` fail-closed.
   - 404 on missing approval is correct.
   - The desktop should create the approval instead of making mobile guess.

## Acceptance Checks

Run these before handing back to mobile:

```bash
curl -sS http://localhost:3001/api/mobile/inbox | jq '{summary, approvals, reviewUnits, items}'
curl -sS 'http://localhost:3001/api/worktrees/diff?sessionKey=<review-session-key>' | jq '{fileCount, additions, deletions, error}'
```

Expected states:

- No work: no approval cards, no review units, no `review:unknown`.
- Inspect-only work: review unit exists with `authority: "inspect_only"`,
  no approval actions, diff endpoint returns content.
- Approval gate: approval unit exists with `authority: "approval_gate"` and
  `approvalId`; `/api/mobile/action` accepts approve/request-changes/deny.

## Mobile Patch Being Made Now

The mobile repo patch made on 2026-07-07:

- Change Review empty state copy from "All caught up" to "No approval gates"
  when inspectable session diffs exist without approval authority.
- Add a Review empty-state CTA into `/diffs` for inspect-only review diffs.
- Make foreground status classification stricter so raw `reviewing` does not
  become `awaiting_review` unless an approval card exists.
- Keep Diffs inspect-only for session-derived review targets; approval actions
  only render for approval-backed targets.
- Stabilize `/diffs` against inbox WebSocket refresh churn. The screen now
  keys its worktree-diff fetch by stable target fields instead of the selected
  target object identity, so a fresh inbox snapshot no longer flips the diff
  reader back to loading for the same selected session.

Mobile verification:

```bash
npx tsc --noEmit
bun run lint
```

The Diffs screen was sampled with six simulator screenshots over six seconds;
all six image hashes matched after the stable-key patch.

## Agents Surface Findings

Observed against the running desktop app on 2026-07-07 while verifying mobile
Agents parity:

- `GET /api/mobile/orchestrator/openclaw-agents` returned three display-identical
  OpenClaw agents:
  - `{ id: "main", name: "Mister" }`
  - `{ id: "main-public", name: "Mister" }`
  - `{ id: "mister-scribe", name: "Mister" }`
- The mobile Agents selector correctly disambiguates those rows with the agent
  id subtitle. The mobile chat patch now also shows the OpenClaw agent id on the
  chat header/composer for runtime-pinned chats, so `Mister / main` is visible
  after selection.
- `GET /api/setup/orchestrator-backends` returned `{ hermes: true }`, and mobile
  renders Hermes as one runtime group, not as multiple agents. That matches the
  intended model: Hermes has many chats, but no per-agent dimension.

Fresh live-turn checks:

```text
OpenClaw main thread: thoughts-1783394601001
Sent WS frame: backend=openclaw, agent=main, permissionMode=plan
Prompt: Mobile connectivity check only. Do not inspect files, run commands, or dispatch work. Reply exactly: Mr main online.
Result: desktop emitted busy, then error tagged backend=openclaw agent=main:
        openclaw gateway exited or failed to spawn before becoming ready

Hermes thread: thoughts-1783394602001
Sent WS frame: backend=hermes, permissionMode=plan
Prompt: Mobile connectivity check only. Do not inspect files or run tools. Reply exactly: Hermes online.
Result: Hermes streamed "Hermes online." and returned ready.
```

Desktop issues to fix for Agents parity:

1. OpenClaw runtime launch is failing before the gateway becomes ready.
   - The mobile route is correct: `orchestrator-send` is tagged
     `backend: "openclaw"` and `agent: "main"`.
   - The failure is desktop/runtime-side, not a mobile misroute to
     `main-public` or `mister-scribe`.

2. Desktop surfaces the mobile OpenClaw turn like a regular Orchestrator chat.
   - Operator observation: the mobile test appeared on desktop in an
     orchestrator chat surface, not as the selected `Mister / main` OpenClaw
     agent.
   - This is the core parity break. OpenClaw can still be an orchestrator inside
     the desktop product model, but it must be surface-separated from the normal
     o8 orchestrator when the phone targets `backend: "openclaw"`.
   - Mobile should not have to pretend OpenClaw is the same workspace chat as
     the default orchestrator. Either:
     - keep `/openclaw` as a separate Agents chat surface with agent rows
       (`Mister / main`, `Mister / main-public`, `Mister / mister-scribe`), or
     - expose OpenClaw as a runtime/model choice in the chat composer labelled
       `OpenClaw`, with the lower model picker simplified for that mode.
   - In either design, a phone send with `backend=openclaw` must not land in the
     unqualified desktop Orchestrator chat without an OpenClaw badge/agent
     identity. That makes it look like a normal orchestrator turn and breaks the
     user's mental model.
   - Fleet/review/diff can still be shared across surfaces, but chat/session
     identity must stay separate until the desktop can explicitly bridge them.

3. Desktop must surface Hermes turns with Hermes identity too.
   - Mobile verified `backend: "hermes"` works end-to-end: the fresh thread
     `thoughts-1783394602001` streamed `Hermes online.` and persisted with
     `backend: "hermes"`, `agent: null`.
   - Hermes is not multiple agents like OpenClaw. It is one runtime/agent with
     multiple chats. That means no `agent` id is expected, but desktop still
     needs to show the chat/transcript as Hermes.
   - Wherever the desktop front end renders Hermes turns, the transcript,
     history row, active chat header, and any composer/runtime badge must say
     `Hermes` or `Hermes Agent`. It should not look like an unqualified regular
     o8 Orchestrator chat.
   - If desktop uses a shared chat shell for Claude/Codex/Hermes/OpenClaw, the
     backend tag must drive visible identity:
     - `backend=hermes` -> `Hermes`
     - `backend=openclaw&agent=main` -> `OpenClaw · Mister · main`
   - This mirrors the OpenClaw requirement: mobile can route correctly, but the
     desktop UI must make the runtime truthful in the transcript and history.

4. Persist OpenClaw `agent` on chat-history/thread rows.
   - The fresh `agent=main` turn persisted in `/api/v2/chat-history` with
     `backend: "openclaw"`, but `/api/mobile/orchestrator/threads?backend=openclaw`
     returned the same row with `agent: null`.
   - Consequence: on reload, mobile groups the thread under `Other` instead of
     `Mister / main`, and the operator loses truth about which Mister was spoken
     to.
   - Start in `src/ws-server.ts` around the `appendMobileOrchestratorUserMessage`
     call in `handleOrchestratorSendMsg`; it passes `backend` but not `agent`.
     Then update `src/lib/mobile/orchestrator-thread-history.ts` if its persisted
     thread schema does not yet carry `agent`.

5. Clear failed OpenClaw thread status.
   - After the gateway-spawn error, the thread list row for
     `thoughts-1783394601001` still returned `status: "busy"` with one user
     message and no assistant message.
   - A terminal OpenClaw error should persist/project `ready`, `failed`, or an
     explicit error state. It should not leave the mobile selector showing a
     permanently busy stale thread.

Agent acceptance checks after desktop fixes:

```bash
TOKEN="$(curl -sS http://localhost:3001/api/mobile/ws-token | jq -r .token)"
curl -sS -H "Authorization: Bearer $TOKEN" \
  'http://localhost:3001/api/mobile/orchestrator/threads?backend=openclaw' \
  | jq '.threads[] | {id, title, backend, agent, status, messageCount}'

curl -sS -H "Authorization: Bearer $TOKEN" \
  'http://localhost:3001/api/mobile/orchestrator/threads?backend=hermes' \
  | jq '.threads[] | {id, title, backend, agent, status, messageCount}'
```

Expected:

- A new `backend=openclaw&agent=main` mobile turn returns text or a truthful
  terminal error, and the thread row keeps `agent: "main"`.
- The same row appears under `Mister / main` on mobile after reload.
- The same turn appears on desktop as an OpenClaw/Mr Agent turn, not as an
  unqualified regular Orchestrator chat. If desktop intentionally shows it in a
  shared chat shell, the header/badge/history row must visibly say
  `OpenClaw · Mister · main`.
- A new `backend=hermes` mobile turn appears on desktop as a Hermes transcript
  and history row. If desktop intentionally shows it in a shared chat shell, the
  header/badge/history row must visibly say `Hermes` or `Hermes Agent`.
- Hermes continues to persist as `backend: "hermes"`, `agent: null`, because it
  is one runtime with multiple chats.

## Fleet Surface Findings

Observed against the running desktop app on 2026-07-07 while checking mobile
Fleet truthfulness:

- `GET /api/mobile/inbox` returned `summary.activeRuns: 0`,
  `summary.reviewItems: 1`, `approvals: []`.
- The same payload carried 22 chat sessions, all with `runtime: "chat"` and
  `sessionKey` values starting with `llm-chat:`.
- There were zero non-chat worker sessions:
  `sessions.filter(s => s.runtime !== "chat" && !s.sessionKey.startsWith("llm-chat:"))`
  returned `[]`.
- `items[]` contained a workspace chat `run_watch` item and the same
  `review:unknown` clean review item called out above.

Mobile behavior after the Fleet patch:

- Mobile Fleet keeps filtering out chat mirrors. It should not show
  orchestrator chats as worker agents just to avoid an empty screen.
- The empty state now says there are no worker agents in fleet, not simply
  "No agents running".
- Fleet rows now prefer useful live signals when diff counts are missing:
  review gate, terminal shell, preview, or the canonical status label. They no
  longer collapse every zero-diff row to "No diff".

Desktop parity gap:

The desktop app appears to have richer agent/runtime state than the mobile inbox
currently exposes. If the desktop Fleet UI can show workers as running, paused,
stopped, blocked, huddling, waiting, failed, needs review, needs merge, or
merged, mobile needs that same worker projection. Do not make mobile infer those
states from chat history or from a clean workspace review snapshot.

Fresh parity mismatch observed later in the same 2026-07-07 session:

- `GET /api/runtime/inventory` showed two live owned Codex worker sessions for
  the same repo/branch:
  - `codex-owned:codex-owned-1783396596568-20bbab7b`
  - `codex-owned:codex-owned-1783396572549-ef8fd2df`
- `GET /api/mobile/inbox?fresh=1` exposed only one non-chat worker row to the
  phone. The other live worker was not representable on mobile Fleet.
- The desktop root cause is in `src/lib/mobile/inbox.ts`:
  `mobileSessionIdentity()` returns `codex-owned:${repoSlug}:${branch}` for
  owned Codex sessions. That collapses two live workers when they share the
  same repo/branch, even if they have different `sessionKey`,
  `runtimeSurface.id`, cwd, worktree, or packet identity.

Required desktop fix:

- Do not dedupe mobile fleet/source sessions by repo+branch. Use the live worker
  identity (`sessionKey` or `runtimeSurface.id`) as the source row key.
- If desktop wants repo/branch grouping, group in the UI or in a separate
  `groupKey`; do not drop worker rows from the mobile source array.
- Preserve per-worker fields for same-branch sessions: `sessionKey`,
  `runtimeSurface.id`, cwd/worktree path, terminal attach state, lifecycle,
  review context, and browser/preview surface.
- Also decide whether dashboard automation lane sessions from
  `/api/lanes?active=false` are part of the desktop's "spawned agents" truth.
  `useWorkspaceTerminal` builds `automationLaneSessions` locally for the
  dashboard, but those rows are not currently part of `/api/mobile/inbox`.
  If the desktop UI counts them as spawned agents, they need to be projected
  into mobile Fleet too.

Mobile mitigation being added now:

- Mobile Fleet now supplements `/api/mobile/inbox` with
  `/api/runtime/inventory?fresh=1` when the paired desktop exposes it.
- Rows are merged by `sessionKey`/id, with runtime inventory supplying the
  complete worker set and inbox approval cards still supplying review authority.
- Raw desktop lifecycle states that the current mobile enum cannot express are
  shown as Fleet-only labels: `Reviewing`, `Needs merge`, `Blocked`, `Paused`,
  or `Stopped`. These labels affect Fleet display and active grouping only;
  they do not grant approval authority or show approve/deny controls.
- This is a mitigation, not the final contract. The canonical desktop fix still
  needs `/api/mobile/inbox` or `/api/mobile/fleet` to expose every worker row
  directly, because other mobile surfaces and the desktop mobile web shell also
  consume the mobile inbox projection.

Recommended shape:

```ts
interface MobileFleetSession {
  id: string;
  sessionKey: string;
  runtime: 'codex' | 'claude-code' | 'openclaw' | 'hermes' | 'unknown';
  status:
    | 'queued'
    | 'running'
    | 'huddling'
    | 'paused'
    | 'stopped'
    | 'blocked'
    | 'awaiting_review'
    | 'needs_merge'
    | 'merged'
    | 'failed'
    | 'idle';
  title: string;
  repo: string;
  repoPath: string;
  branch: string;
  worktreePath?: string | null;
  terminalSessionName?: string | null;
  terminalAvailable?: boolean;
  previewUrl?: string | null;
  filesChanged?: number;
  additions?: number;
  deletions?: number;
  approvalId?: string;
  reviewAuthority?: 'approval_gate' | 'inspect_only' | null;
  actions: Array<
    | 'inspect'
    | 'open_terminal'
    | 'open_preview'
    | 'pause'
    | 'resume'
    | 'stop'
    | 'approve'
    | 'request_changes'
    | 'merge'
  >;
  lastEventAt?: string | null;
  lastActivityAt?: number;
}
```

This can be delivered as a dedicated `/api/mobile/fleet` endpoint or as a
canonical `fleetSessions[]` array on `/api/mobile/inbox`. Either is fine, but
the worker fleet must be separate from:

- `runtime: "chat"` workspace/orchestrator mirrors.
- clean/unknown workspace review snapshots.
- approval cards, which remain the authority for approve/deny actions.

Fleet acceptance checks after desktop fixes:

```bash
TOKEN="$(curl -sS http://localhost:3001/api/mobile/ws-token | jq -r .token)"
curl -sS -H "Authorization: Bearer $TOKEN" \
  'http://localhost:3001/api/runtime/inventory?fresh=1' \
  | jq '[.agents[] | select(.runtime != "chat") | {sessionKey, runtime, status, workspace, branch, surfaceId: .runtimeSurface.id, cwd: .runtimeSurface.cwd}]'

curl -sS -H "Authorization: Bearer $TOKEN" \
  'http://localhost:3001/api/mobile/inbox?fresh=1' \
  | jq '{
      summary,
      nonChatSessions: [.sessions[] | select(.runtime != "chat" and (.sessionKey | startswith("llm-chat:") | not)) | {sessionKey, runtime, status, workspace, branch, terminalSessionName, previewUrl}],
      itemKinds: (.items | group_by(.kind) | map({kind: .[0].kind, count: length}))
    }'
```

Expected:

- No workers: mobile receives no non-chat fleet sessions and shows an honest
  empty fleet, even if there are chat mirrors or review-only items.
- Running/paused/stopped worker: mobile receives one non-chat fleet session with
  its real lifecycle status and available actions.
- Multiple same-branch workers: runtime inventory and mobile inbox expose the
  same worker count and the same unique session keys. Same repo/branch rows may
  group together visually, but none disappear from the source payload.
- Needs review / needs merge worker: mobile receives diff stats, branch/repo,
  approval authority when applicable, and merge/review actions only when the
  desktop can actually execute them.
