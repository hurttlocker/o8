import { NextRequest, NextResponse } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { readActiveSharedCheckoutTeam } from '@/lib/orchestrator/shared-checkout-team';
import { findOwnedLaunchByMutationId } from '@/lib/runtimes/shared/owned-session-index';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  const repoPath = request.nextUrl.searchParams.get('repoPath')?.trim();
  if (!repoPath || !repoPath.startsWith('/') || repoPath.length > 4_096) {
    return NextResponse.json({ error: 'A valid repoPath is required.' }, { status: 400 });
  }
  try {
    const team = readActiveSharedCheckoutTeam(repoPath);
    const members = team ? await Promise.all(team.members.filter((member) => member.surfaceId)
      .map(async ({ surfaceId, runtime: workerRuntime, taskName, state, clientMutationId }) => {
        const launch = await findOwnedLaunchByMutationId(clientMutationId);
        return { surfaceId, runtime: workerRuntime, taskName, state,
          outcome: launch?.surfaceId === surfaceId ? launch.outcome : 'unknown' };
      })) : [];
    return NextResponse.json({
      team: team ? {
        repoPath: team.path,
        parentThreadId: team.parentThreadId,
        members,
      } : null,
    });
  } catch {
    return NextResponse.json({ error: 'Unable to read the active Fast team.' }, { status: 500 });
  }
}
