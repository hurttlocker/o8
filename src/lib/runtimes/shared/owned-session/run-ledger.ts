import type { OwnedRunRecord, OwnedSessionRecord } from './types';

export const MAX_RETAINED_OWNED_RUNS = 16;

function hasValidLedger(session: OwnedSessionRecord, recentRuns: OwnedRunRecord[]): boolean {
  const ledger = session.runIdentityLedger;
  return ledger?.version === 1
    && (ledger.totalRuns === null
      ? !ledger.complete
      : Number.isSafeInteger(ledger.totalRuns)
        && ledger.totalRuns >= recentRuns.length
        && (!ledger.complete || ledger.totalRuns === recentRuns.length));
}

/**
 * Record one new run without ever upgrading legacy or truncated history back
 * to complete. The total remains monotonic even after the bounded array rolls.
 */
export function prependOwnedRun(
  session: OwnedSessionRecord,
  run: OwnedRunRecord,
): void {
  const recentRuns = Array.isArray(session.recentRuns) ? session.recentRuns : [];
  const ledgerValid = hasValidLedger(session, recentRuns);
  const priorTotal = ledgerValid ? session.runIdentityLedger!.totalRuns : null;
  session.runIdentityLedger = {
    version: 1,
    totalRuns: priorTotal === null ? null : priorTotal + 1,
    complete: ledgerValid
      && session.runIdentityLedger!.complete
      && recentRuns.length < MAX_RETAINED_OWNED_RUNS,
  };
  session.recentRuns = [run, ...recentRuns].slice(0, MAX_RETAINED_OWNED_RUNS);
}
