import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ORCHESTRATOR_HOME_REPO_SENTINEL,
  resolveOrchestratorClientRepoPath,
} from './orchestrator-home-mode';

describe('desktop orchestrator home mode', () => {
  it('turns a missing repo into the home wire sentinel', () => {
    expect(resolveOrchestratorClientRepoPath(null)).toBe(ORCHESTRATOR_HOME_REPO_SENTINEL);
    expect(resolveOrchestratorClientRepoPath('')).toBe(ORCHESTRATOR_HOME_REPO_SENTINEL);
    expect(resolveOrchestratorClientRepoPath('/repo/o8')).toBe('/repo/o8');
  });

  it('does not retain the old no-repo refusal in the send entry point', () => {
    const source = readFileSync(new URL('./useOrchestratorStream.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('No repo selected yet');
    expect(source).not.toContain('orch-no-repo');
  });
});
