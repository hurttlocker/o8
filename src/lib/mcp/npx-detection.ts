/**
 * Tiny helper that identifies commands belonging to the "lazy-fetch" family
 * (npx, npm exec, pnpm dlx, bunx, yarn dlx).  These commands may download a
 * package on first run and therefore need a much longer probe timeout.
 */

const NPX_FAMILY_COMMANDS = new Set([
  'npx',
  'npm',   // covers `npm exec …`
  'pnpm',  // covers `pnpm dlx …`
  'bunx',
  'yarn',  // covers `yarn dlx …`
]);

/**
 * Returns true when `command` is one of the lazy-fetch package runners.
 * The check is case-insensitive and matches basename only, so
 * `/usr/local/bin/npx` also returns true.
 */
export function isNpxFamily(command: string): boolean {
  if (!command) return false;
  // Strip path prefix so `/usr/local/bin/npx` → `npx`
  const base = command.replace(/^.*[/\\]/, '').toLowerCase();
  return NPX_FAMILY_COMMANDS.has(base);
}
