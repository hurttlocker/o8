/**
 * Git ref safety guard — used wherever a user/persisted branch, tag, or base
 * ref becomes a positional argument to git. Kept in its own leaf module (no
 * imports) so API routes and lane code can pull it in without dragging the git
 * barrel's heavier dependencies — or risking an import cycle.
 */

/**
 * True when `ref` is a plain git ref name that is safe to pass as a git
 * argument. Even with execFile (no shell), a ref starting with `-` is parsed
 * as a git OPTION (e.g. `--output=<file>` on `git diff` writes a file), and a
 * `..` can smuggle a revision range. Git forbids spaces/control chars in ref
 * names anyway, so this allowlist rejects nothing legitimate.
 */
export function isSafeGitRef(ref: unknown): ref is string {
  return (
    typeof ref === 'string' &&
    ref.length > 0 &&
    ref.length <= 255 &&
    /^[A-Za-z0-9._/-]+$/.test(ref) &&
    !ref.startsWith('-') &&
    !ref.includes('..')
  );
}
