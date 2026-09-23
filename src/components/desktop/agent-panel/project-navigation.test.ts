import { describe, expect, it, vi } from 'vitest';

import type { ProjectRecord } from '../repo-registry/useProjects';
import type { RepoRegistryEntry } from '../repo-registry/shared';
import { groupProjectNavigationItems, selectWorkingRepository, visibleProjectNavigationItems } from './project-navigation';

function project(id: string, name: string, repoPaths: string[]): ProjectRecord {
  return { id, name, repoPaths, createdAt: '2026-09-22T00:00:00.000Z' };
}

function repo(id: string, name: string, localPath: string): RepoRegistryEntry {
  return {
    id,
    name,
    localPath,
    remoteUrl: null,
    defaultBranch: 'main',
    addedAt: '2026-09-22T00:00:00.000Z',
    lastOpenedAt: null,
    storagePressureParkingDisabled: false,
    setup: {
      envMode: 'copy',
      envFiles: [],
      installCommand: null,
      installOnCreateWorkspace: false,
      buildCommand: null,
      runBuildOnCreateWorkspace: false,
      devCommand: null,
      defaultPort: null,
      workspaceIsolationPreference: 'auto',
    },
  };
}

describe('project navigation projection', () => {
  const repos = [
    repo('repo-web', 'sample-web', '/tmp/sample-web'),
    repo('repo-api', 'sample-api', '/tmp/sample-api'),
    repo('repo-loose', 'loose', '/tmp/loose'),
  ];

  it('hides virtual fallbacks for repos already shown inside a real project', () => {
    const result = visibleProjectNavigationItems([
      project('sample-product', 'Sample product', ['/tmp/sample-web/', '/tmp/sample-api']),
      project('repo:repo-web', 'sample-web', ['/tmp/sample-web']),
      project('repo:repo-api', 'sample-api', ['repo-api']),
      project('repo:repo-loose', 'loose', ['/tmp/loose']),
    ], repos);

    expect(result.map((entry) => entry.id)).toEqual(['sample-product', 'repo:repo-loose']);
  });

  it('preserves genuine memberships when the same repo belongs to multiple real projects', () => {
    const result = visibleProjectNavigationItems([
      project('product-dev', 'Product dev', ['/tmp/sample-web']),
      project('release-work', 'Release work', ['/tmp/sample-web']),
      project('repo:repo-web', 'sample-web', ['/tmp/sample-web']),
    ], repos);

    expect(result.map((entry) => entry.id)).toEqual(['product-dev', 'release-work']);
  });

  it('keeps every real project reachable while separating the current project from other groups', () => {
    const projects = [
      project('sample-web-auto', 'sample-web', ['/tmp/sample-web']),
      project('sample-product', 'Sample product', ['/tmp/sample-web', '/tmp/sample-api']),
      project('sample-api-auto', 'sample-api', ['/tmp/sample-api']),
    ];

    const result = groupProjectNavigationItems(projects, 'sample-product');

    expect(result.currentProject?.id).toBe('sample-product');
    expect(result.otherProjects.map((entry) => entry.id)).toEqual(['sample-web-auto', 'sample-api-auto']);
  });

  it('focuses the repository workspace before falling back to global repo selection', () => {
    const fallback = vi.fn();
    const focusWorkspace = vi.fn(() => true);
    const target = { id: 'repo-api', name: 'sample-api', localPath: '/tmp/sample-api', remoteUrl: null, defaultBranch: 'main' };

    expect(selectWorkingRepository(target, fallback, focusWorkspace)).toBe('workspace');
    expect(focusWorkspace).toHaveBeenCalledWith({ repoId: 'repo-api', repoPath: '/tmp/sample-api' });
    expect(fallback).not.toHaveBeenCalled();

    focusWorkspace.mockReturnValue(false);
    expect(selectWorkingRepository(target, fallback, focusWorkspace)).toBe('fallback');
    expect(fallback).toHaveBeenCalledWith('repo-api');
  });
});
