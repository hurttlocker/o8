/**
 * Targeting Machine — the scorer.
 *
 * A DELIBERATELY DUMB, deterministic heuristic. No learning, no model — free,
 * instant, offline, so the triage never dead-ends:
 *   impact       = centrality ⊕ churn      (if you touch this, how much moves?)
 *   opportunity  = complexity ⊕ recent-pain (how much room to improve, how likely?)
 *   score        = impact × opportunity     (1–25), rank desc, top-N
 * Each axis is bucketed to 1–5. The one-line `rationale` here is a deterministic
 * fallback — step 5 replaces it with the configured cheap-triage model's take,
 * falling back to this when no triage model is reachable.
 */

import type { TargetSignals } from './signals';

export interface TargetScore {
  path: string;
  /** 1–5 — blast radius if this file changes. */
  impact: number;
  /** 1–5 — how much room/need for improvement. */
  opportunity: number;
  /** impact × opportunity (1–25). */
  score: number;
  /** One-line "why point an agent here" (deterministic heuristic; step 5 upgrades). */
  rationale: string;
  /** Raw signals carried through for the row/tooltip + observability logging. */
  signals: TargetSignals;
}

export const DEFAULT_TOP_N = 50;

/** value < t[0] → 1, < t[1] → 2, < t[2] → 3, < t[3] → 4, else 5. */
function bucket(value: number, thresholds: [number, number, number, number]): number {
  for (let i = 0; i < thresholds.length; i += 1) {
    if (value < thresholds[i]) return i + 1;
  }
  return 5;
}

const clamp1to5 = (n: number): number => Math.max(1, Math.min(5, Math.round(n)));

/** Sub-scores, exported so the rationale + tests can reason about the drivers. */
export function subScores(s: TargetSignals): {
  centrality: number; churn: number; complexity: number; impact: number; opportunity: number;
} {
  const centrality = bucket(s.inbound, [1, 3, 8, 20]); // 0 importers → 1; 20+ → 5
  const churn = bucket(s.churn, [1, 3, 8, 15]);
  const complexity = Math.max(bucket(s.symbolCount, [3, 10, 25, 50]), bucket(s.loc, [50, 150, 400, 800]));
  // impact: centrality dominates, churn boosts "matters now".
  const impact = clamp1to5(0.7 * centrality + 0.3 * churn);
  // opportunity: complexity dominates, recent-pain (churn) boosts.
  const opportunity = clamp1to5(0.6 * complexity + 0.4 * churn);
  return { centrality, churn, complexity, impact, opportunity };
}

/** Deterministic one-line rationale — names the 1–2 strongest drivers. */
export function heuristicRationale(s: TargetSignals): string {
  const clauses: Array<{ weight: number; text: string }> = [];
  if (s.inbound >= 3) clauses.push({ weight: s.inbound, text: `${s.inbound} files import it — a change ripples widely` });
  if (s.churn >= 3) clauses.push({ weight: s.churn * 2, text: `${s.churn} commits in the window — actively changing` });
  if (s.loc >= 400 || s.symbolCount >= 25) clauses.push({ weight: Math.max(s.loc / 100, s.symbolCount), text: `large + dense (${s.loc} LOC, ${s.symbolCount} symbols) — refactor room` });
  if (clauses.length === 0) {
    return s.inbound === 0 && s.churn === 0
      ? 'Peripheral + stable — low priority for agent firepower'
      : `Modest signals (${s.inbound} importers, ${s.churn} recent commits) — lower priority`;
  }
  return clauses.sort((a, b) => b.weight - a.weight).slice(0, 2).map((c) => c.text).join('; ');
}

/** Score one file (pure). */
export function scoreFile(s: TargetSignals): TargetScore {
  const { impact, opportunity } = subScores(s);
  return { path: s.path, impact, opportunity, score: impact * opportunity, rationale: heuristicRationale(s), signals: s };
}

/**
 * Score + rank a repo's files, highest score first. Deterministic tie-break:
 * score desc → centrality (inbound) desc → path asc. Returns the top-N.
 */
export function scoreTargets(signals: TargetSignals[], topN = DEFAULT_TOP_N): TargetScore[] {
  return signals
    .map(scoreFile)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.signals.inbound !== a.signals.inbound) return b.signals.inbound - a.signals.inbound;
      return a.path.localeCompare(b.path);
    })
    .slice(0, topN);
}
