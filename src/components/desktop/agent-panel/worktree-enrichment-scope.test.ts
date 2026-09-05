import { describe, expect, it } from 'vitest';

import { deriveWorktreeEnrichmentRepoPaths } from './worktree-enrichment-scope';

describe('worktree enrichment scope', () => {
  it('does not scan registered repositories when the fleet has no agents', () => {
    const registeredRepoPaths = Array.from(
      { length: 1_000 },
      (_, index) => `/repos/repo-${index}`,
    );

    expect(deriveWorktreeEnrichmentRepoPaths({
      agents: [],
      workspaces: [],
      registeredRepoPaths,
    })).toEqual([]);
  });

  it('selects only repositories that back current agents and deduplicates them', () => {
    expect(deriveWorktreeEnrichmentRepoPaths({
      agents: [
        { sessionKey: 'agent:one' },
        { sessionKey: 'agent:two' },
      ],
      workspaces: [
        { sessionKey: 'agent:one', repoPath: '/repos/one/' },
        { sessionKey: 'agent:two', repoPath: '/repos/one' },
        { sessionKey: 'stale', repoPath: '/repos/two' },
      ],
      registeredRepoPaths: ['/repos/one', '/repos/two', '/repos/three'],
    })).toEqual(['/repos/one']);
  });

  it('uses the longest registered root for nested fallback paths', () => {
    expect(deriveWorktreeEnrichmentRepoPaths({
      agents: [{
        sessionKey: 'agent:nested',
        runtimeSurface: { cwd: '/repos/mono/packages/app/worktree' },
      }],
      workspaces: [],
      registeredRepoPaths: ['/repos/mono', '/repos/mono/packages/app'],
    })).toEqual(['/repos/mono/packages/app']);
  });

  it('does not fall back to scanning every repo when an agent has no known scope', () => {
    expect(deriveWorktreeEnrichmentRepoPaths({
      agents: [{ sessionKey: 'agent:unknown', workspace: 'unknown' }],
      workspaces: [],
      registeredRepoPaths: ['/repos/one', '/repos/two'],
    })).toEqual([]);
  });
});
