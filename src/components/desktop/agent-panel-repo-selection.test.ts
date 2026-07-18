import { describe, expect, it } from 'vitest';
import type { RepoFocusRepo } from './repo-focus/types';
import {
  deriveActiveProjectRepos,
  deriveAgentPanelRailRepos,
  canCreateOrchestratorForRepo,
  resolveGlobalNewSessionRepo,
} from './agent-panel-repo-selection';

function repo(name: string): RepoFocusRepo {
  return {
    id: name,
    name,
    localPath: `/repos/${name}`,
    remoteUrl: null,
    defaultBranch: 'main',
  };
}

describe('resolveGlobalNewSessionRepo', () => {
  it('trusts a rail selection outside the active project', () => {
    const activeProjectRepo = repo('active-project');
    const selectedRepo = repo('unassigned');

    expect(resolveGlobalNewSessionRepo(selectedRepo, [activeProjectRepo])).toBe(selectedRepo);
  });

  it('falls back to the active project first repo without a rail selection', () => {
    const activeProjectRepo = repo('active-project');

    expect(resolveGlobalNewSessionRepo(null, [activeProjectRepo])).toBe(activeProjectRepo);
  });
});

describe('canCreateOrchestratorForRepo', () => {
  it('rejects a repo whose registered folder is missing', () => {
    const missingRepo = repo('missing');
    missingRepo.readiness = {
      state: 'missing',
      label: 'Folder missing',
      summary: `Repo folder not found at ${missingRepo.localPath}.`,
      currentBranch: null,
      onDefaultBranch: null,
      originConfigured: false,
      dirty: false,
      missingEnvFiles: [],
    };

    expect(canCreateOrchestratorForRepo(missingRepo)).toBe(false);
    expect(canCreateOrchestratorForRepo(repo('ready'))).toBe(true);
  });
});

describe('deriveAgentPanelRailRepos', () => {
  it('adds only repos absent from every project to the rail', () => {
    const activeProjectRepo = repo('active-project');
    const otherProjectRepo = repo('other-project');
    const unassignedRepo = repo('unassigned');

    expect(deriveAgentPanelRailRepos(
      [activeProjectRepo],
      [activeProjectRepo, otherProjectRepo, unassignedRepo],
      [activeProjectRepo.localPath, otherProjectRepo.localPath],
    )).toEqual([activeProjectRepo, unassignedRepo]);
  });
});

describe('deriveActiveProjectRepos', () => {
  it('preserves project order and omits unregistered paths', () => {
    const firstRepo = repo('first');
    const secondRepo = repo('second');

    expect(deriveActiveProjectRepos(
      [secondRepo.localPath, '/repos/missing', firstRepo.localPath],
      [firstRepo, secondRepo],
    )).toEqual([secondRepo, firstRepo]);
  });
});
