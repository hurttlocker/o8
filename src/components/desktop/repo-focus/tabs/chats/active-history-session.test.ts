import { describe, expect, it } from 'vitest';
import {
  isLatestHistoryOpenRequest,
  resolveRailActiveSessionKey,
  supersedeHistoryOpenRequest,
} from './helpers';

describe('resolveRailActiveSessionKey', () => {
  it('clears the previous history row for a fresh orchestrator tab', () => {
    expect(resolveRailActiveSessionKey('llm-chat:thoughts-old', {
      kind: 'orchestrator',
    })).toBeNull();
  });

  it('selects the thread once the focused orchestrator binds one', () => {
    expect(resolveRailActiveSessionKey(null, {
      kind: 'orchestrator',
      orchestratorThreadId: 'thoughts-new',
    })).toBe('llm-chat:thoughts-new');
  });

  it('keeps the clicked history row selected while its workspace tab is binding', () => {
    expect(resolveRailActiveSessionKey('llm-chat:thoughts-new', {
      id: 'thoughts-old',
      kind: 'orchestrator',
      orchestratorThreadId: 'thoughts-old',
    }, 'llm-chat:thoughts-new')).toBe('llm-chat:thoughts-new');
  });

  it('recognizes an opened history tab before its internal thread binding settles', () => {
    expect(resolveRailActiveSessionKey('llm-chat:thoughts-new', {
      id: 'thoughts-new',
      kind: 'orchestrator',
    })).toBe('llm-chat:thoughts-new');
  });

  it('moves selection when switching between existing orchestrator tabs', () => {
    expect(resolveRailActiveSessionKey('llm-chat:thoughts-old', {
      kind: 'orchestrator',
      orchestratorThreadId: 'thoughts-other',
    })).toBe('llm-chat:thoughts-other');
  });

  it('preserves the existing session key for non-orchestrator tabs', () => {
    expect(resolveRailActiveSessionKey('codex:session-one', {
      kind: 'chat',
    })).toBe('codex:session-one');
  });
});

describe('isLatestHistoryOpenRequest', () => {
  it('rejects delayed retries from an older history click', () => {
    expect(isLatestHistoryOpenRequest(7, 8)).toBe(false);
    expect(isLatestHistoryOpenRequest(8, 8)).toBe(true);
  });

  it('rejects a delayed rail retry after an in-tab navigation wins', () => {
    const railRequestId = 8;
    const latestRequestId = supersedeHistoryOpenRequest(railRequestId);

    expect(isLatestHistoryOpenRequest(railRequestId, latestRequestId)).toBe(false);
  });
});
