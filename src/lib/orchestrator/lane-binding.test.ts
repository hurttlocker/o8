import { describe, expect, it } from 'vitest';

import { normalizeLaneBinding } from './lane-binding';
import { isDispatchableRuntime } from './runtime-capabilities';

describe('lane binding runtime persistence', () => {
  it('preserves explicit cloud ownership without enabling mission dispatch', () => {
    const binding = normalizeLaneBinding({
      tileId: 'remote-tile', tabId: 'remote-tab', runtime: 'cloud',
      laneId: 'remote-lane', sessionKey: 'cloud-owned:remote-job',
      repoPath: '/fixture/coordinator', worktreePath: null,
    });
    expect(binding).toMatchObject({
      runtime: 'cloud', laneId: 'remote-lane',
      sessionKey: 'cloud-owned:remote-job', worktreePath: null,
    });
    expect(isDispatchableRuntime('cloud')).toBe(false);
  });

  it('retains the existing unknown-runtime fallback', () => {
    expect(normalizeLaneBinding({
      tileId: 'tile', tabId: 'tab', runtime: 'unknown-runtime',
    })?.runtime).toBe('codex');
  });
});
