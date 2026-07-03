export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { homedir } from 'node:os';

import { getScores } from '@/lib/targeting/store';
import { resolveTargetingRouting } from '@/lib/targeting/routing';
import { logDispatchChoice } from '@/lib/targeting/observability';
import { createMission, dispatchMission } from '@/lib/orchestrator/operator-mission-service';
import { nextInlineIssueNumbers } from '@/lib/orchestrator/operator-mission-service/shared';

/**
 * Point an agent at a targeted file. Resolves the file's dispatch routing (cheap
 * triage vs premium action tier → runtime/model, step 6), then creates + fires a
 * mission with those requestedRuntime/requestedModel — which flow through
 * `resolveWorkerRouting` unchanged. Gated under /api/panel/* (loopback + token).
 * No throw — structured errors.
 */
export async function POST(request: Request) {
  let body: { repoPath?: string; path?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }

  const rawRepo = (body.repoPath || process.cwd()).trim();
  const repoPath = rawRepo.startsWith('~') ? rawRepo.replace('~', homedir()) : rawRepo;
  const filePath = (body.path || '').trim();
  if (!filePath) return NextResponse.json({ ok: false, error: 'path is required' }, { status: 400 });

  // Server-authoritative signals: read the cached score row (the triage GET just
  // wrote it). Avoids trusting client-supplied signals for the routing decision.
  const score = getScores(repoPath).find((s) => s.path === filePath);
  if (!score) {
    return NextResponse.json(
      { ok: false, error: 'no cached score for that file — run the triage (GET /api/panel/targets) first.' },
      { status: 409 },
    );
  }

  const routing = resolveTargetingRouting(score.signals);

  try {
    const [issueNumber] = nextInlineIssueNumbers(1);
    const brief = [
      `Operator-directed target from the Targeting Machine (impact ${score.impact}/5, opportunity ${score.opportunity}/5).`,
      `Why here: ${score.rationale}`,
      '',
      `Review and improve \`${filePath}\`. Keep the change surgical and well-scoped; open a reviewable diff.`,
    ].join('\n');

    const mission = await createMission({
      issues: [{ number: issueNumber!, title: `Targeting: ${filePath}`, body: brief, url: '' }],
      repoPath,
      runtime: routing.runtime,
      requestedRuntime: routing.runtime,
      requestedModel: routing.model || null,
      // Close the loop: the tier's effort now reaches the worker launch (cheap
      // triage → low, premium action → high). A no-op for gemini/opencode tiers.
      requestedEffort: routing.effort,
      constraints: '',
      workerIntent: routing.tier === 'triage' ? 'light_worker' : 'heavy_worker',
    });

    await dispatchMission({ missionId: mission.missionId });

    // Observability seed for the future recalibration loop — the operator's
    // ground-truth choice (which file, at what score/tier).
    logDispatchChoice({
      repoPath, path: filePath, missionId: mission.missionId,
      tier: routing.tier, runtime: routing.runtime, model: routing.model || null, effort: routing.effort,
      impact: score.impact, opportunity: score.opportunity, score: score.score,
    });

    return NextResponse.json({
      ok: true,
      missionId: mission.missionId,
      path: filePath,
      tier: routing.tier,
      runtime: routing.runtime,
      model: routing.model || null,
      effort: routing.effort,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'dispatch failed' },
      { status: 500 },
    );
  }
}
