import { sep } from 'node:path';

const TOP_LEVEL_NAMED_FILES = new Set(['CLAUDE.md', 'AGENTS.md', 'DESIGN.md']);

/**
 * Match documentation paths shared by the batch distiller and live watcher.
 * Named files retain their original rules; markdown below docs/ is recursive.
 */
export function isWhitelistedDocPath(relPath: string): boolean {
  const segments = relPath.split(sep);
  const base = segments.at(-1) ?? relPath;
  const depth = segments.length - 1;

  if (TOP_LEVEL_NAMED_FILES.has(base)) return true;
  if (base === 'README.md' && depth === 0) return true;
  if (segments[0] === 'docs' && depth >= 1 && /\.md$/i.test(base)) return true;
  return false;
}
