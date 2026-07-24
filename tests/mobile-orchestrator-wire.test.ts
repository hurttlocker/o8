import { describe, expect, it } from 'vitest';
import type { MobileOrchestratorThread } from '@/lib/mobile/types';
import {
  buildMobileOrchestratorSend,
  buildMobileOrchestratorSubscribe,
  mobileOrchestratorRouteFromThread,
  mobileOrchestratorRouteKey,
} from '@/lib/mobile/orchestrator-wire';

function thread(id: string): MobileOrchestratorThread {
  return {
    id,
    title: 'Thread',
    lastMessageAt: '2026-07-23T12:00:00.000Z',
    runtime: 'codex',
    status: 'idle',
    messageCount: 0,
    repoPath: '/tmp/o8',
    repoName: 'o8',
    repoBranch: 'main',
    githubOwner: null,
    githubRepo: null,
    backend: 'codex',
    agent: 'operator',
  };
}

describe('mobile orchestrator wire routing', () => {
  it('keeps same-repo threads distinct and sends their full route identity', () => {
    const first = mobileOrchestratorRouteFromThread(thread('thoughts-first'));
    const second = mobileOrchestratorRouteFromThread(thread('thoughts-second'));

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(mobileOrchestratorRouteKey(first)).not.toBe(mobileOrchestratorRouteKey(second));
    expect(buildMobileOrchestratorSubscribe(first!, 41)).toEqual({
      type: 'orchestrator-subscribe',
      repoPath: '/tmp/o8',
      threadId: 'thoughts-first',
      backend: 'codex',
      agent: 'operator',
      since: 41,
    });
    expect(buildMobileOrchestratorSend(first!, 'Ship it', 'mutation-1')).toEqual({
      type: 'orchestrator-send',
      repoPath: '/tmp/o8',
      threadId: 'thoughts-first',
      backend: 'codex',
      agent: 'operator',
      message: 'Ship it',
      permissionMode: 'full',
      clientMutationId: 'mutation-1',
    });
  });
});
