import { describe, expect, it } from 'vitest';

import {
  duplicateOrchestratorSendAck,
  orchestratorCommandAckCorrelation,
  orchestratorInterruptAckDisposition,
  orchestratorSendIdempotencyScope,
  resolveOrchestratorCommandCorrelationId,
} from './orchestrator-command-idempotency';

describe('orchestrator command correlation compatibility', () => {
  it('prefers clientMessageId and trims the accepted value', () => {
    expect(resolveOrchestratorCommandCorrelationId({
      clientMessageId: ' message-1 ',
      clientMutationId: 'mutation-1',
    })).toBe('message-1');
  });

  it('falls back to the native clientMutationId alias', () => {
    expect(resolveOrchestratorCommandCorrelationId({
      clientMessageId: '   ',
      clientMutationId: ' mutation-1 ',
    })).toBe('mutation-1');
  });

  it('keeps legacy no-id commands uncorrelated', () => {
    expect(resolveOrchestratorCommandCorrelationId({})).toBeUndefined();
    expect(orchestratorCommandAckCorrelation(undefined)).toEqual({});
  });

  it('mirrors a resolved id into both ACK aliases', () => {
    expect(orchestratorCommandAckCorrelation('command-1')).toEqual({
      clientMessageId: 'command-1',
      clientMutationId: 'command-1',
    });
  });

  it('keeps persisted send reservations isolated by route identity', () => {
    const base = {
      repoPath: '/repo/o8',
      backend: 'codex',
      agent: '',
      threadId: 'thoughts-one',
    };
    const scope = orchestratorSendIdempotencyScope(base);

    expect(orchestratorSendIdempotencyScope({ ...base })).toBe(scope);
    expect(orchestratorSendIdempotencyScope({ ...base, threadId: 'thoughts-two' })).not.toBe(scope);
    expect(orchestratorSendIdempotencyScope({ ...base, backend: 'claude' })).not.toBe(scope);
    expect(orchestratorSendIdempotencyScope({ ...base, agent: 'worker-two' })).not.toBe(scope);
  });

  it('locks the duplicate send ACK states', () => {
    expect(duplicateOrchestratorSendAck(true)).toEqual({
      state: 'duplicate-in-progress',
      duplicate: true,
    });
    expect(duplicateOrchestratorSendAck(false)).toEqual({
      state: 'replayed',
      duplicate: true,
    });
  });

  it('makes repeated interrupts an explicit idempotent disposition', () => {
    expect(orchestratorInterruptAckDisposition({ hasController: true, alreadyAborted: false })).toEqual({
      state: 'accepted',
      interrupted: true,
      duplicate: false,
    });
    expect(orchestratorInterruptAckDisposition({ hasController: true, alreadyAborted: true })).toEqual({
      state: 'already-interrupted',
      interrupted: true,
      duplicate: true,
    });
    expect(orchestratorInterruptAckDisposition({ hasController: false, alreadyAborted: false })).toEqual({
      state: 'not-running',
      interrupted: false,
      duplicate: false,
    });
  });
});
