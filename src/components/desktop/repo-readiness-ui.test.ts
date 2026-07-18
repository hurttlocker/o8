import { describe, expect, it } from 'vitest';
import { attentionRank, readinessTone as dashboardReadinessTone } from '@/app/dashboard/utils';
import { deriveWorkflowStage } from '@/lib/workflows/status';
import type { RepoReadiness } from '@/lib/repos/types';
import { readinessTone as canvasReadinessTone } from './canvas-utils';
import { repoReadinessDisplayLabel, repoReadinessPalette } from './repo-registry/shared';

function readiness(state: RepoReadiness['state']): RepoReadiness {
  return {
    state,
    label: state === 'missing' ? 'Folder missing' : 'Needs attention',
    summary: 'Repo folder not found at /repos/example.',
    currentBranch: null,
    onDefaultBranch: null,
    originConfigured: false,
    dirty: false,
    missingEnvFiles: [],
  };
}

describe('missing repo readiness presentation', () => {
  it('uses the blocked danger tone on canvas surfaces', () => {
    expect(canvasReadinessTone(readiness('missing'))).toEqual(canvasReadinessTone(readiness('blocked')));
  });

  it('uses the registry danger palette and Folder missing label', () => {
    expect(repoReadinessPalette('missing')).toEqual({
      background: 'var(--t-danger-soft)',
      border: 'var(--t-danger-border)',
      color: 'var(--t-danger)',
    });
    expect(repoReadinessDisplayLabel('missing', 'Folder missing')).toBe('Folder missing');
  });

  it('ranks missing as red and workflow-blocking in dashboard helpers', () => {
    expect(dashboardReadinessTone('missing')).toBe('red');
    expect(attentionRank('Folder missing')).toBeGreaterThanOrEqual(attentionRank('Blocked'));
    expect(deriveWorkflowStage({ readinessState: 'missing' })).toMatchObject({ key: 'blocked', label: 'Blocked' });
  });
});
