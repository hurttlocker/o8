import path from 'node:path';

/** Repository assertion of the complete workspace read closure of all install lifecycle
 * scripts (root and dependency): helpers, config, data and presence-sensitive inputs must all be listed.
 * Locked dependency packages and recipe config/patch inputs are already covered.
 * Absence preserves the conservative same-tree requirement for enabled lifecycle scripts.
 */
export function dependencyCloneLifecycleInputs(manifestBytes: Buffer, tracked: string[]): string[] | null {
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as { o8DependencyClone?: unknown };
  if (manifest.o8DependencyClone === undefined) return null;
  const declaration = manifest.o8DependencyClone as { lifecycleInputs?: unknown } | null;
  const inputs = declaration?.lifecycleInputs;
  if (!Array.isArray(inputs) || inputs.length > 64 || inputs.some((entry) => (
    typeof entry !== 'string' || entry.length > 256 || !entry
    || path.posix.normalize(entry) !== entry || path.posix.isAbsolute(entry)
    || entry.split('/').some((part: string) => ['.', '..', '.git', 'node_modules', ''].includes(part))
    || entry.includes('\\') || !tracked.includes(entry)
  ))) throw new Error('Dependency clone lifecycle inputs must name tracked, contained regular files.');
  return [...new Set(inputs as string[])].sort();
}
