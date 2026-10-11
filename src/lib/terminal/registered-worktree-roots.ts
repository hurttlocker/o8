import { laneGitInvocation } from '@/lib/lane/lane-git';
import { MAX_PERSISTED_TABS } from '@/lib/terminal/tab-state';

/** Only reciprocal Git associations may extend a registered checkout's scope. */
export function includeRegisteredWorktreeRoots(registeredRoots: Set<string>, candidates: string[]): Set<string> {
  const roots = new Set(registeredRoots);
  const commonDirectories = new Map<string, string | null>();
  // One requested scope may supply at most the existing persisted-tab cap.
  // Untrusted oversized snapshots must not expand synchronous Git work.
  for (const candidate of [...new Set(candidates)].slice(0, MAX_PERSISTED_TABS)) {
    if ([...roots].some((root) => candidate === root || candidate.startsWith(`${root}/`))) continue;
    for (const registered of registeredRoots) {
      try {
        if (!commonDirectories.has(registered)) {
          commonDirectories.set(registered, laneGitInvocation(registered, registered, ['rev-parse', '--git-common-dir'], true).env.GIT_COMMON_DIR ?? null);
        }
        const common = commonDirectories.get(registered);
        if (!common) continue;
        // laneGitInvocation verifies the marker, host backlink and commondir.
        // Standalone clones are valid lane contexts but are not registered
        // worktrees, so require the same registered Git object store too.
        const invocation = laneGitInvocation(candidate, registered, ['rev-parse', '--git-common-dir'], true);
        if (invocation.env.GIT_COMMON_DIR !== common) continue;
        roots.add(candidate);
        break;
      } catch {
        commonDirectories.set(registered, commonDirectories.get(registered) ?? null);
        // Missing or inconsistent associations retain the existing rejection.
      }
    }
  }
  return roots;
}
