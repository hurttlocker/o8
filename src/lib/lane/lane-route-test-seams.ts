/**
 * Test-only hooks for the /api/lanes route. Request bodies cannot override the
 * production repo-action lease budget, and Next.js route modules may neither
 * accept a custom second argument nor export extra symbols, so the real-path
 * suites set the budget through this module instead.
 */
let repoActionLeaseMaxWaitMsOverride: number | undefined;

export function setRepoActionLeaseMaxWaitMsForTests(ms?: number): void {
  repoActionLeaseMaxWaitMsOverride = ms;
}

export function repoActionLeaseMaxWaitMsForTests(): number | undefined {
  return repoActionLeaseMaxWaitMsOverride;
}
