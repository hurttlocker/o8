import { describe, expect, it } from 'vitest';
import {
  ActiveOrchestratorRouteRegistry,
  promoteOrchestratorSubscribers,
  type OrchestratorSubscriptionRoute,
} from './orchestrator-subscription-promotion';

function route(
  clientId: string,
  repoPath: string,
  threadId: string,
): OrchestratorSubscriptionRoute {
  return {
    clientId,
    repoPath,
    threadId,
    sessionName: `openclaw:${threadId}`,
    backend: 'openclaw',
    agent: 'main',
  };
}

describe('orchestrator subscriber promotion', () => {
  it('moves every same-thread view to Single\'s actual Codex route only', () => {
    const subscriptions = new Map<string, OrchestratorSubscriptionRoute>([
      ['sender::openclaw::main', route('sender', '/repo', 'thoughts-1')],
      ['canvas::openclaw::main', route('canvas', '/repo', 'thoughts-1')],
      ['other-thread::openclaw::main', route('other-thread', '/repo', 'thoughts-2')],
      ['other-repo::openclaw::main', route('other-repo', '/other', 'thoughts-1')],
    ]);

    expect(promoteOrchestratorSubscribers(subscriptions, {
      repoPath: '/repo',
      threadId: 'thoughts-1',
      fromBackend: 'openclaw',
      toBackend: 'codex',
      toSessionName: 'codex:thoughts-1',
    })).toBe(2);
    expect(subscriptions.get('sender::codex::')).toMatchObject({
      backend: 'codex', sessionName: 'codex:thoughts-1', agent: '',
    });
    expect(subscriptions.get('canvas::codex::')).toMatchObject({
      backend: 'codex', sessionName: 'codex:thoughts-1', agent: '',
    });
    expect(subscriptions.has('other-thread::codex::')).toBe(false);
    expect(subscriptions.has('other-repo::codex::')).toBe(false);
  });

  it('routes a late same-thread subscriber to active Codex and releases safely', () => {
    const registry = new ActiveOrchestratorRouteRegistry();
    const first = registry.register({
      repoPath: '/repo',
      threadId: 'thoughts-1',
      fromBackend: 'openclaw',
      toBackend: 'codex',
      toSessionName: 'codex:thoughts-1',
    });
    expect(registry.resolve({
      repoPath: '/repo', threadId: 'thoughts-1', requestedBackend: 'openclaw',
    })).toMatchObject({ toBackend: 'codex', toSessionName: 'codex:thoughts-1' });
    expect(registry.resolve({
      repoPath: '/repo', threadId: 'thoughts-2', requestedBackend: 'openclaw',
    })).toBeNull();

    const newer = registry.register({
      repoPath: '/repo',
      threadId: 'thoughts-1',
      fromBackend: 'openclaw',
      toBackend: 'codex',
      toSessionName: 'codex:thoughts-1-new',
    });
    registry.release(first);
    expect(registry.resolve({
      repoPath: '/repo', threadId: 'thoughts-1', requestedBackend: 'openclaw',
    })?.toSessionName).toBe('codex:thoughts-1-new');
    registry.release(newer);
    expect(registry.resolve({
      repoPath: '/repo', threadId: 'thoughts-1', requestedBackend: 'openclaw',
    })).toBeNull();
  });
});
