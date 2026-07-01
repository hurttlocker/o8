/**
 * Targeting Machine — observability.
 *
 * Structured `[targeting]` log lines, mirroring dispatch/routing.ts's
 * `[dispatch-routing]` recommendation logging. Two events seed the FUTURE
 * outcome-feedback recalibration loop (explicitly deferred — we only LOG now):
 *   - triage runs (what got scored, how high)
 *   - dispatch choices (which file the operator actually pointed an agent at,
 *     at what score/tier — the ground-truth signal for recalibration)
 *
 * The full per-file scores + signals persist durably in the targeting_scores
 * store; these lines are the greppable observability trail on top of that.
 */

import type { TargetScore } from './scorer';

/** Log a triage run — repo, count, rationale mode, and the top few by score. */
export function logTriageRun(repoPath: string, targets: TargetScore[], rationaleMode: 'llm' | 'heuristic'): void {
  const top = targets.slice(0, 5).map((t) => `${t.path}=${t.score}`).join(' ');
  console.log(
    `[targeting] triaged repo=${repoPath} files=${targets.length} rationales=${rationaleMode} top=[${top}]`,
  );
}

/** Log a dispatch choice — the operator pointed an agent at a file. The key
 *  signal for the future recalibration loop (did high scores get dispatched?). */
export function logDispatchChoice(input: {
  repoPath: string;
  path: string;
  missionId: string;
  tier: string;
  runtime: string;
  model: string | null;
  effort: string;
  impact: number;
  opportunity: number;
  score: number;
}): void {
  console.log(
    `[targeting] dispatch repo=${input.repoPath} path=${input.path} tier=${input.tier} `
      + `runtime=${input.runtime} model=${input.model ?? 'default'} effort=${input.effort} `
      + `impact=${input.impact} opportunity=${input.opportunity} score=${input.score} mission=${input.missionId}`,
  );
}
