import { describe, expect, it } from 'vitest';

import { canPreserveScopedTabs, computeRestoredTabs, mergeUserSpawnedTabs } from './terminal-restore';
import type { TerminalTab } from './types';

function tab(overrides: Partial<TerminalTab>): TerminalTab {
  return {
    id: overrides.id ?? `tab-${Math.random().toString(36).slice(2, 8)}`,
    label: 'Tab',
    kind: 'terminal',
    tmuxSession: null,
    createdAt: 0,
    lastActivity: 0,
    ...overrides,
  };
}

/**
 * GQXEZD (2026-07-16): the silent "New session does nothing" saga. On slow
 * (Rosetta) boots the repo registry hydrates after the no-repo restore lands;
 * the restoreKey flip must NOT wipe the operator's live conversations, and a
 * restore landing must NOT eat tabs spawned while it was in flight.
 */
describe('canPreserveScopedTabs — orchestrator conversations survive repo-scope flips', () => {
  it('preserves an orchestrator tab bound to a thread even with no repo stamped', () => {
    const tabs = [tab({ kind: 'orchestrator', orchestratorThreadId: 'thoughts-abc' })];
    expect(canPreserveScopedTabs(tabs, '/Users/chris/loggins26-site')).toBe(true);
  });

  it('preserves a freshly user-spawned orchestrator tab (no thread yet)', () => {
    const tabs = [tab({ kind: 'orchestrator', freshSpawn: true })];
    expect(canPreserveScopedTabs(tabs, '/Users/chris/loggins26-site')).toBe(true);
  });

  it('still lets a blank boot-default orchestrator be replaced by a repo switch', () => {
    // No thread, not user-spawned — expendable, so a real repo switch can
    // load that repo's saved tabs (pre-GQXEZD behavior preserved).
    const tabs = [tab({ kind: 'orchestrator' })];
    expect(canPreserveScopedTabs(tabs, '/Users/chris/loggins26-site')).toBe(false);
  });

  it('keeps the existing chat-tab and empty-set behavior', () => {
    expect(canPreserveScopedTabs([], '/repo')).toBe(false);
    expect(canPreserveScopedTabs([tab({ kind: 'chat' })], '/repo')).toBe(true);
  });
});

describe('mergeUserSpawnedTabs — restore landing never eats an in-flight user spawn', () => {
  it('appends a tab spawned during the restore await', () => {
    const preIds = new Set(['old-1']);
    const restored = [tab({ id: 'old-1', kind: 'orchestrator', orchestratorThreadId: 't1' })];
    const current = [
      tab({ id: 'old-1', kind: 'orchestrator', orchestratorThreadId: 't1' }),
      tab({ id: 'spawned-mid-restore', kind: 'orchestrator', freshSpawn: true }),
    ];
    const merged = mergeUserSpawnedTabs(restored, current, preIds);
    expect(merged.map((t) => t.id)).toEqual(['old-1', 'spawned-mid-restore']);
  });

  it('returns the restored set untouched when nothing was spawned mid-flight', () => {
    const restored = [tab({ id: 'a' }), tab({ id: 'b' })];
    const merged = mergeUserSpawnedTabs(restored, [tab({ id: 'a' })], new Set(['a']));
    expect(merged).toBe(restored);
  });

  it('does not duplicate a tab the restore itself already produced', () => {
    const restored = [tab({ id: 'a' })];
    const merged = mergeUserSpawnedTabs(restored, [tab({ id: 'a' })], new Set<string>());
    expect(merged.map((t) => t.id)).toEqual(['a']);
  });
});

describe('computeRestoredTabs — optimistic crash recovery', () => {
  it('returns saved tabs for immediate paint before background validation', async () => {
    const result = await computeRestoredTabs({
      version: 1,
      activeTabId: 'thoughts-saved',
      savedAt: new Date().toISOString(),
      tabs: [{ id: 'thoughts-saved', label: 'Saved thread', kind: 'orchestrator', cliAgent: 'shell' }],
    }, {
      preferredRepo: null,
      defaultTab: 'terminal',
      createDefaultChatTab: () => tab({ kind: 'llm-chat' }),
    }, undefined, 'optimistic');

    expect(result?.tabs).toMatchObject([{ id: 'thoughts-saved', kind: 'orchestrator', orchestratorThreadId: 'thoughts-saved' }]);
    expect(result?.activeTabId).toBe('thoughts-saved');
  });

  it.each([
    ['pi', 'pi-owned:restore-pi'],
    ['qwen', 'qwen-owned:restore-qwen'],
  ] as const)('restores %s owned chat identity without wrapping it as Codex', async (runtime, sessionKey) => {
    const result = await computeRestoredTabs({
      version: 1,
      activeTabId: `chat-${runtime}`,
      savedAt: new Date().toISOString(),
      tabs: [{
        id: `chat-${runtime}`,
        label: `${runtime} worker`,
        kind: 'chat',
        cliAgent: runtime,
        chatRuntime: 'codex',
        chatSessionKey: `codex:${sessionKey}`,
      }],
    }, {
      preferredRepo: null,
      defaultTab: 'terminal',
      createDefaultChatTab: () => tab({ kind: 'llm-chat' }),
    }, undefined, 'optimistic');

    expect(result?.tabs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'chat',
        chatRuntime: runtime,
        chatSessionKey: sessionKey,
      }),
    ]));
  });
});
