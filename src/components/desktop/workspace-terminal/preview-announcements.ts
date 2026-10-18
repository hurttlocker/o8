import { buildRepoStateScope } from '@/lib/terminal/tab-state';

const STORAGE_PREFIX = 'o8:preview-announcements:v1:';
const scopes = new Map<string, Set<string>>();

/** One automatic Browser open per port and terminal session; Ports can always reopen it. */
export function claimPreviewAnnouncement(scope: string, repoPath: string | undefined, session: string, port: number): boolean {
  const key = `${STORAGE_PREFIX}${scope}${repoPath ? `:${buildRepoStateScope(repoPath)}` : ''}`;
  let seen = scopes.get(key);
  if (!seen) {
    seen = new Set<string>();
    try {
      const stored: unknown = JSON.parse(window.localStorage.getItem(key) ?? '[]');
      if (Array.isArray(stored)) seen = new Set(stored.filter((entry): entry is string => typeof entry === 'string').slice(-256));
    } catch {
      // Keep the same behavior in memory when storage is unavailable.
    }
    if (scopes.size >= 128) scopes.delete(scopes.keys().next().value!);
    scopes.set(key, seen);
  }
  const announcement = JSON.stringify([session, port]);
  if (seen.has(announcement)) return false;
  seen.add(announcement);
  while (seen.size > 256) seen.delete(seen.values().next().value!);
  try { window.localStorage.setItem(key, JSON.stringify([...seen])); } catch { /* Memory still retains the announcement. */ }
  return true;
}
