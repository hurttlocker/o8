import { describe, expect, it } from 'vitest';
import {
  buildChatSessionSnapshots,
  computeCliChatSession,
  resolveActiveChatSessionKey,
} from './terminal-session-ops';
import { buildQueuedContextCard } from './utils';
import type { RegisteredRepo } from './types';

const repo: RegisteredRepo = {
  name: 'o8',
  localPath: '/tmp/o8',
  branch: 'main',
};

describe('workspace terminal focused CLI session', () => {
  it('reuses a cloud session without rewriting its identity or inventing a local model', () => {
    const first = computeCliChatSession({ runtime: 'cloud', repo, targetSessionKey: 'cloud:worker', label: 'Review worker' }, [], '');
    const next = computeCliChatSession({ runtime: 'codex', repo, targetSessionKey: 'cloud:worker', label: 'Review worker' }, first.tabs, first.activeTabId);
    expect(next.tabs).toHaveLength(1);
    expect(next.activeTabId).toBe(first.activeTabId);
    expect(next.tabs[0]).toMatchObject({ chatRuntime: 'cloud', chatSessionKey: 'cloud:worker', label: 'Review worker' });
    expect(next.tabs[0].chatModel).toBeUndefined();
  });

  it.each(['codex:cloud:worker', 'cloud-owned:cloud:worker'])('repairs an existing malformed cloud tab: %s', (key) => {
    const existing = computeCliChatSession({ runtime: 'codex', targetSessionKey: 'codex:old', label: 'Review worker' }, [], '');
    existing.tabs[0].chatSessionKey = key;
    const reopened = computeCliChatSession({ runtime: 'cloud', targetSessionKey: 'cloud:worker' }, existing.tabs, existing.activeTabId);
    expect(reopened.tabs).toHaveLength(1);
    expect(reopened.tabs[0]).toMatchObject({ chatRuntime: 'cloud', chatSessionKey: 'cloud:worker' });
    expect(reopened.tabs[0].chatModel).toBeUndefined();
  });

  it('restores the selected cloud repository when reusing an unscoped tab', () => {
    const existing = computeCliChatSession({ runtime: 'cloud', targetSessionKey: 'cloud:worker' }, [], '');
    const reopened = computeCliChatSession({ runtime: 'cloud', targetSessionKey: 'cloud:worker', repo }, existing.tabs, existing.activeTabId);
    expect(reopened.tabs).toHaveLength(1);
    expect(reopened.tabs[0].repo).toEqual(repo);
  });

  it('keeps a captured design region on the staged context card', () => {
    const previewImageDataUri = 'data:image/png;base64,captured-region';
    const result = computeCliChatSession(
      {
        runtime: 'claude-code',
        repo,
        initialText: 'Tighten the spacing in this region.',
        draftReason: 'design-draw',
        previewImageDataUri,
      },
      [],
      '',
    );

    const injection = result.tabs[0]?.chatDraftInjection;
    expect(injection?.previewImageDataUri).toBe(previewImageDataUri);
    expect(injection && buildQueuedContextCard(injection).previewImageDataUri).toBe(previewImageDataUri);
  });

  it('moves the published active session key when focus switches to a spawned agent tab', () => {
    const first = computeCliChatSession(
      {
        runtime: 'codex',
        repo,
        targetSessionKey: 'codex-owned:first-chat',
        label: 'Original chat',
      },
      [],
      '',
    );
    const spawned = computeCliChatSession(
      {
        runtime: 'codex',
        repo,
        targetSessionKey: 'codex-owned:spawned-agent',
        label: 'Spawned agent',
      },
      first.tabs,
      first.activeTabId,
    );

    const snapshots = buildChatSessionSnapshots(
      spawned.tabs,
      spawned.activeTabId,
      repo.localPath,
      repo.branch ?? 'main',
      'tile-root',
      'tile-root',
    );

    expect(snapshots.map((session) => ({
      sessionKey: session.sessionKey,
      current: session.isCurrentSession,
    }))).toEqual([
      { sessionKey: 'codex-owned:first-chat', current: false },
      { sessionKey: 'codex-owned:spawned-agent', current: true },
    ]);
    expect(resolveActiveChatSessionKey(snapshots, 'codex-owned:first-chat')).toBe('codex-owned:spawned-agent');
  });
});
