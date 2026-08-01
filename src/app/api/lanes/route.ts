import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { resolveRequestPrincipalContext, workerPacketRefusal } from '@/lib/auth/principal';
import { getLane, getLaneEvents, listLanes, listActiveLanes } from '@/lib/lane/registry';
import { summarizeLaneArchive } from '@/lib/lane/archive-summary';
import { collapseArchivedLanesByTask } from '@/lib/lanes/collapse-archived-by-task';
import { codename } from '@/lib/agents/codename';
import { dispatch } from '@/lib/lane/commands';
import { currentLaneMergePolicy } from '@/lib/lane/dogfood-guard';
import { reconcileOrphanedWorktrees } from '@/lib/lane/reconcile';
import type { LaneCommand } from '@/lib/lane/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const denied = requirePanelAuth(req);
  if (denied) return denied;

  // #534 follow-up — reconcile lanes whose worktrees were deleted out-of-band
  // (orchestrator bash-merge bypasses the merge verb) so the sidebar doesn't
  // keep showing stale 'reviewing' rows. Awaited (async git probes since #1498)
  // so the response below reflects the reconciled lane state.
  await reconcileOrphanedWorktrees();

  const url = new URL(req.url);
  const activeOnly = url.searchParams.get('active') !== 'false';
  // #1292 — collapse=true folds the archived multiply (many lanes per task, one
  // per reset/redispatch/supervisor-relaunch) into one row per task via the
  // shared primitive, so a structured-state query an agent makes returns "one
  // task = one entry" — the same view the history sidebar renders. Active lanes
  // pass through untouched; only retired (archived/completed) lanes collapse.
  const collapse = url.searchParams.get('collapse') === 'true';

  const principal = resolveRequestPrincipalContext(req);
  const visibleLanes = activeOnly ? listActiveLanes() : listLanes();
  const baseLanes = principal.role === 'worker'
    ? visibleLanes.filter((lane) => Boolean(principal.packetId) && lane.packetId === principal.packetId)
    : visibleLanes;
  const resolvedLanes = collapse
    ? [
        ...baseLanes.filter((lane) => lane.status !== 'archived' && lane.status !== 'completed'),
        ...collapseArchivedLanesByTask(
          baseLanes.filter((lane) => lane.status === 'archived' || lane.status === 'completed'),
        ),
      ]
    : baseLanes;

  // Stamp the memorable codename (same pure fn that labels the canvas card and
  // resolves voice "[Name], [task]") so every lane consumer — the canvas, voice
  // status, mobile — sees the agent by the SAME name. Additive, deterministic.
  const mergePolicy = currentLaneMergePolicy();
  const lanes = resolvedLanes.map((lane) => ({
    ...lane,
    codename: codename(lane.id),
    mergeMode: mergePolicy.mode,
    mergeModeNote: mergePolicy.note,
    archiveSummary: lane.status === 'archived' || lane.status === 'completed'
      ? summarizeLaneArchive(lane, getLaneEvents(lane.id, 80))
      : null,
  }));

  return NextResponse.json({ lanes }, {
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}

export async function POST(req: NextRequest) {
  const denied = requirePanelAuth(req);
  if (denied) return denied;

  const body = await req.json().catch(() => null) as LaneCommand | null;
  if (!body || !body.verb) {
    return NextResponse.json({ ok: false, note: 'Missing command verb.' }, { status: 400 });
  }

  // Actor comes from the CREDENTIAL, never the body (#1173 H1: a self-asserted
  // actor defaulted to trusted 'user', which pre-approves merges and skips the
  // governance card — so any loopback caller, including a dispatched worker's
  // token or a prompt-injected same-origin fetch, could merge to main
  // silently). Only a live operator credential (ws-token) may act as 'user';
  // every other caller — worker token, tokenless loopback — is clamped to
  // 'orchestrator', which routes governed verbs through the approval card
  // exactly like /api/orchestrator/merge's worker branch. Internal server
  // callers import dispatch() directly and are unaffected.
  const principal = resolveRequestPrincipalContext(req);
  const commandPacketId = body.verb === 'open_lane'
    ? body.packetId ?? null
    : 'laneId' in body
      ? getLane(body.laneId)?.packetId ?? null
      : null;
  const ownershipRefusal = workerPacketRefusal(principal, commandPacketId);
  if (ownershipRefusal) {
    return NextResponse.json(
      { ok: false, error: { code: ownershipRefusal.code, message: ownershipRefusal.message } },
      { status: 403 },
    );
  }
  const command: LaneCommand = {
    ...body,
    actor: principal.role === 'operator' ? (body.actor ?? 'user') : 'orchestrator',
  };

  try {
    const result = await dispatch(command);
    return NextResponse.json(result, {
      status: result.ok ? 200 : 422,
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Command failed.';
    return NextResponse.json({ ok: false, note: message }, { status: 500 });
  }
}
