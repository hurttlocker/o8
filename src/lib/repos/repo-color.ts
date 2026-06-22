/**
 * Deterministic repo-identity color (2026-06-22).
 *
 * A workspace can hold tabs across several repos at once — a chat scoped to one
 * repo, the orchestrator on another, a dispatched worker on a third. With every
 * tab styled the same you can't tell which project a tab belongs to. This maps a
 * repo (by its localPath) to a stable color so the tab strip can mark project
 * identity at a glance.
 *
 * Curated palette, NOT random HSL — hand-picked to stay mutually distinct and
 * pleasant in both light and dark, and to echo the runtime accent tones already
 * in the app (orange/blue/green/purple). Hashing the localPath keeps a repo the
 * same color across sessions and machines.
 */
const REPO_PALETTE = [
  '#e07a3a', // orange
  '#2563eb', // blue
  '#22c55e', // green
  '#a855f7', // purple
  '#ec4899', // pink
  '#14b8a6', // teal
  '#eab308', // amber
  '#6366f1', // indigo
  '#ef4444', // red
  '#84cc16', // lime
];

export function repoColor(key: string | null | undefined): string {
  if (!key) return 'var(--t-text-faint)';
  let h = 0;
  for (let i = 0; i < key.length; i += 1) {
    h = (Math.imul(h, 31) + key.charCodeAt(i)) >>> 0;
  }
  return REPO_PALETTE[h % REPO_PALETTE.length];
}
