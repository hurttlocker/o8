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
