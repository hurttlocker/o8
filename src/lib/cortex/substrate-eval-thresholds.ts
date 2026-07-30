/**
 * Threshold values referenced by `docs/operations/substrate-eval-gate.md`. Surfaced as
 * an importable constant so the UI can display the same numbers, the route
 * can hold the runtime check, and the doc can't drift silently from either.
 *
 * Lives in `lib/` rather than the route file because Next.js App Router
 * disallows arbitrary exports from `route.ts` (only specific symbols like
 * GET/POST/dynamic/etc. are valid Route exports).
 */
export const SUBSTRATE_EVAL_THRESHOLDS = {
  /** Eval trigger at this many `session_outcomes` rows. */
  outcomesEval: 5_000,
  /** Eval trigger at recall p95 above this many milliseconds. */
  p95Ms: 200,
  /** Sustained-over window in days for the p95 trigger. */
  sustainedDays: 7,
} as const;

export type SubstrateEvalThresholds = typeof SUBSTRATE_EVAL_THRESHOLDS;
