import { describe, expect, it, vi } from 'vitest';
import type { RealtimeEventEnvelope } from '@/lib/realtime/types';
import { openWorkerFromMutation } from './workspace-worker-mutation';

describe('native worker mutation bridge', () => {
  it('opens a Fast launch in its parent split without a packet or lane', () => {
    const openWorker = vi.fn(async () => {});
    const event = {
      channel: 'mutation', event: 'mutation.record',
      data: { mutation: {
        action: 'launch', status: 'queued', sessionKey: 'codex-owned:fast-a',
        repoPath: '/repo/fast', runtime: 'codex',
        launchContext: {
          source: 'agent', presentation: 'split', repoContext: 'registered',
          parentThreadId: 'thoughts-fast-parent', checkoutMode: 'shared',
        },
      } },
    } as RealtimeEventEnvelope;
    expect(openWorkerFromMutation(event, openWorker)).toBe(true);
    expect(openWorker).toHaveBeenCalledWith(expect.objectContaining({
      sessionKey: 'codex-owned:fast-a', repoPath: '/repo/fast',
      launchContext: expect.objectContaining({ parentThreadId: 'thoughts-fast-parent' }),
    }));
  });
});
