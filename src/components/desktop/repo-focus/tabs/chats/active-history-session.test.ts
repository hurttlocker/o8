import { describe, expect, it } from 'vitest';
import { resolveRailActiveSessionKey } from './helpers';

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
