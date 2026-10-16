import type { PrCheck, CheckBucket } from './types';

export function checkBucket(check: PrCheck): CheckBucket {
  const conclusion = (check.conclusion ?? '').toLowerCase();
  if (['failure', 'timed_out', 'action_required', 'startup_failure'].includes(conclusion)) return 'failing';
  if (conclusion === 'success') return 'passed';
  if (conclusion === 'skipped' || conclusion === 'cancelled') return 'skipped';
  if (conclusion) return 'neutral';
  return 'running';
}

export function summarizeChecks(checks: PrCheck[]) {
  const counts = { total: checks.length, passed: 0, failing: 0, running: 0 };
  for (const check of checks) {
    const bucket = checkBucket(check);
    if (bucket === 'passed') counts.passed++;
    if (bucket === 'failing') counts.failing++;
    if (bucket === 'running') counts.running++;
  }
  const tone = counts.failing ? 'failure' : counts.running ? 'pending' : counts.passed ? 'success' : 'unknown';
  const label = counts.failing
    ? `${counts.failing} failing · ${counts.passed} of ${counts.total} passing`
    : counts.running ? `${counts.running} pending · ${counts.passed} of ${counts.total} passing`
      : counts.total ? `${counts.passed} of ${counts.total} passing` : 'No checks reported';
  return { ...counts, tone, label };
}
