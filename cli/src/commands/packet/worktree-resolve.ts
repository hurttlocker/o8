/**
 * Shared cwd→lane resolver for `o8 packet info` / `scope` / `log`.
 *
 * Walks up from process.cwd() looking for a `.cortex-worktrees/packet-*`
 * (canonical) or `.claude/worktrees/packet-*` (legacy) parent, then asks
 * the lanes API which lane that worktree belongs to.
 */

import { sep } from 'node:path';
import { apiFetch } from '../../api.js';
import { resolveConfig } from '../../config.js';

export interface WorktreeMatch {
  worktreePath: string;
  packetSlug: string;
  layout: 'cortex-worktrees' | 'claude-worktrees';
}

interface MinimalLane {
  id: string;
  packetId: string | null;
  worktreePath: string | null;
}

export function detectWorktree(cwd: string): WorktreeMatch | null {
  const parts = cwd.split(sep);
  for (let i = parts.length - 1; i >= 1; i--) {
    const prev = parts[i - 1];
    const cur = parts[i];
    if (!cur || !cur.startsWith('packet-')) continue;
    if (prev === '.cortex-worktrees') {
      return {
        worktreePath: parts.slice(0, i + 1).join(sep),
        packetSlug: cur.slice('packet-'.length),
        layout: 'cortex-worktrees',
      };
    }
    if (prev === 'worktrees' && parts[i - 2] === '.claude') {
      return {
        worktreePath: parts.slice(0, i + 1).join(sep),
        packetSlug: cur.slice('packet-'.length),
        layout: 'claude-worktrees',
      };
    }
  }
  return null;
}

/**
 * Resolve the current cwd to a lane id (and packet id if known). Returns
 * null when cwd is not inside a recognised packet worktree — callers should
 * decide whether that's a hard error or a fallback to explicit-id flow.
 */
export async function resolveLaneFromCwd(): Promise<{ laneId: string; packetId: string | null; match: WorktreeMatch } | null> {
  const match = detectWorktree(process.cwd());
  if (!match) return null;

  const cfg = resolveConfig();
  const res = await apiFetch<{ lanes: MinimalLane[] }>(cfg, '/api/lanes', { query: { active: 'false' } });
  const lanes = res.data?.lanes ?? [];

  const exact = lanes.find((l) => l.worktreePath === match.worktreePath);
  const slug = exact
    ?? lanes.find((l) => l.packetId && match.packetSlug.includes(l.packetId))
    ?? lanes.find((l) => l.worktreePath && l.worktreePath.endsWith(`packet-${match.packetSlug}`));

  if (!slug) return null;
  return { laneId: slug.id, packetId: slug.packetId, match };
}
