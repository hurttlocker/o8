import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  isOrchestratorHomePath,
  resolveOrchestratorMessageRepoPath,
  resolveOrchestratorRepoPath,
} from './repo-path';

describe('orchestrator repo-path resolution', () => {
  it('resolves the home wire sentinel identically for every message verb', () => {
    const send = resolveOrchestratorMessageRepoPath({ type: 'orchestrator-send', repoPath: '~' });
    const interrupt = resolveOrchestratorMessageRepoPath({ type: 'orchestrator-interrupt', repoPath: '~' });
    const subscribe = resolveOrchestratorMessageRepoPath({ type: 'orchestrator-subscribe', repoPath: '~' });
    const status = resolveOrchestratorMessageRepoPath({ type: 'orchestrator-status', repoPath: '~' });

    expect(send).toBe(homedir());
    expect(interrupt).toBe(send);
    expect(subscribe).toBe(send);
    expect(status).toBe(send);
    expect(isOrchestratorHomePath(send)).toBe(true);
  });

  it('normalizes ordinary paths without treating them as home mode', () => {
    expect(resolveOrchestratorRepoPath('/tmp/o8-repo')).toBe('/tmp/o8-repo');
    expect(isOrchestratorHomePath('/tmp/o8-repo')).toBe(false);
  });
});
