/**
 * Strict validator for a git ref/branch name from UNTRUSTED input (e.g. a
 * worker-reported branch in POST /api/worker/event). Even though the sinks use
 * execFile (no shell), a value that leads with `-` is parsed by git as an OPTION
 * — `git fetch origin --upload-pack=<cmd>` is RCE on local/ext transports
 * (SECURITY_AUDIT_2026-07-02 §MED-3). Validate at the ingestion choke point so a
 * poisoned value is nulled before it can reach any `git … <branch>` invocation.
 */
export function isValidGitRefName(name: string): boolean {
  if (!name || name.length > 255) return false;
  if (name.startsWith('-')) return false;           // no git option injection
  if (name.startsWith('/') || name.endsWith('/')) return false;
  if (name.endsWith('.lock')) return false;
  if (name.includes('..') || name.includes('//')) return false;
  if (name.includes('@{')) return false;
  // git-check-ref-format safe charset: letters/digits and . _ / - only — no
  // space, ~ ^ : ? * [ \ or control chars.
  return /^[A-Za-z0-9._/-]+$/.test(name);
}
