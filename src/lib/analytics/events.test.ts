import { describe, expect, it } from 'vitest';

import { sanitizeProductEvent } from './events';

describe('product telemetry payload allowlist', () => {
  it('accepts only known events and their exact coarse fields', () => {
    expect(sanitizeProductEvent('merge.approved', {
      runtime: 'codex',
      pushed: true,
      repoName: 'private-repo',
      path: '/Users/example/private',
      prompt: 'secret prompt',
    })).toEqual({ event: 'merge.approved', props: { runtime: 'codex', pushed: true } });

    expect(sanitizeProductEvent('app.opened', { transcript: 'secret' })).toEqual({ event: 'app.opened' });
    expect(sanitizeProductEvent('orchestrator.message', { prompt: 'secret' })).toEqual({ event: 'orchestrator.message' });
    expect(sanitizeProductEvent('unknown.event', {})).toBeNull();
    expect(sanitizeProductEvent('dispatch.started', { runtime: 'private-repo' })).toBeNull();
  });
});
