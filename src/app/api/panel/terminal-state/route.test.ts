import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { GET, POST } from './route';
import { listReposFresh } from '@/lib/repos/registry';
import { buildNewChatGPTPlanTab, buildPersistedState } from '@/components/desktop/workspace-terminal/terminal-tab-handlers';
import { computeRestoredTabs } from '@/components/desktop/workspace-terminal/terminal-restore';

const dataDir = process.env.CORTEX_IDE_DATA_DIR!;
const stateDir = path.join(dataDir, 'terminal-states');
const stateUrl = 'http://localhost/api/panel/terminal-state?scope=tile-root';

beforeEach(async () => {
  rmSync(path.join(dataDir, 'repos.json'), { force: true });
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(path.join(dataDir, 'terminal-state.json'), { force: true });
  await listReposFresh();
});

describe('terminal state restore without a registered repo', () => {
  it('persists and restores a plan chat through the desktop state route without adopting a repository or terminal', async () => {
    const tab = buildNewChatGPTPlanTab();
    const persisted = buildPersistedState([tab], tab.id);
    const save = await POST(new Request(stateUrl, { method: 'POST', body: JSON.stringify(persisted) }));
    expect(save.status).toBe(200);
    const response = await GET(new Request(stateUrl));
    expect(response.status).toBe(200);
    const restored = await computeRestoredTabs(await response.json(), { preferredRepo: { name: 'unrelated', localPath: '/unrelated' }, defaultTab: 'terminal', createDefaultChatTab: () => { throw new Error('The explicit plan tab must restore'); } });
    expect(restored?.activeTabId).toBe(tab.id);
    expect(restored?.tabs).toEqual([expect.objectContaining({ id: tab.id, label: 'ChatGPT plan', kind: 'chatgpt-plan', tmuxSession: null })]);
    expect(restored?.tabs[0].repo).toBeUndefined();
    expect(restored?.sessionsToAttach).toEqual([]); expect(restored?.deadTerminalTabs).toEqual([]);
  });

  it('reloads a persisted global terminal and filters an orphaned repo tab', async () => {
    const save = await POST(new Request(stateUrl, {
      method: 'POST',
      body: JSON.stringify({
        version: 1,
        activeTabId: 'global-shell',
        savedAt: '2026-09-24T00:00:00.000Z',
        tabs: [
          { id: 'global-shell', kind: 'terminal', label: 'Terminal 1', cliAgent: 'shell', tmuxSession: 'cortex-dash-live' },
          { id: 'old-repo', kind: 'terminal', label: 'Old repo', cliAgent: 'shell', repoPath: '/missing-repo', tmuxSession: 'cortex-dash-old' },
        ],
      }),
    }));
    expect(save.status).toBe(200);

    const restored = await GET(new Request(stateUrl));
    expect(restored.status).toBe(200);
    const state = await restored.json() as { tabs: Array<{ id: string; tmuxSession?: string }> };
    expect(state.tabs).toEqual([
      expect.objectContaining({ id: 'global-shell', tmuxSession: 'cortex-dash-live' }),
    ]);
  });

  it('does not restore a repo-scoped tab from fallback state when its repo is gone', async () => {
    const save = await POST(new Request('http://localhost/api/panel/terminal-state?scope=repo-old', {
      method: 'POST',
      body: JSON.stringify({
        version: 1,
        activeTabId: 'old-repo',
        savedAt: '2026-09-24T00:00:00.000Z',
        tabs: [{ id: 'old-repo', kind: 'terminal', label: 'Old repo', cliAgent: 'shell', repoPath: '/missing-repo' }],
      }),
    }));
    expect(save.status).toBe(200);

    const restored = await GET(new Request(stateUrl));
    expect(restored.status).toBe(204);
  });

  it('filters removed-repo tabs in a fallback selected for a registered repo', async () => {
    const repoPath = path.join(dataDir, 'registered-repo');
    writeFileSync(path.join(dataDir, 'repos.json'), JSON.stringify({
      version: 1,
      repos: [{ id: 'registered', name: 'registered-repo', localPath: repoPath }],
    }));
    await listReposFresh();
    await POST(new Request('http://localhost/api/panel/terminal-state?scope=repo-older', {
      method: 'POST',
      body: JSON.stringify({
        version: 1,
        activeTabId: 'registered-tab',
        savedAt: '2026-09-24T00:00:00.000Z',
        tabs: [
          { id: 'registered-tab', kind: 'terminal', label: 'Registered', cliAgent: 'shell', repoPath },
          { id: 'removed-tab', kind: 'terminal', label: 'Removed', cliAgent: 'shell', repoPath: '/missing-repo' },
        ],
      }),
    }));

    const restored = await GET(new Request(`${stateUrl.replace('tile-root', 'repo-current')}&repoPath=${encodeURIComponent(repoPath)}`));
    expect(restored.status).toBe(200);
    const state = await restored.json() as { tabs: Array<{ id: string }> };
    expect(state.tabs.map((tab) => tab.id)).toEqual(['registered-tab']);
  });

  it('filters retired packet chat tabs from the nonempty fallback', async () => {
    await POST(new Request('http://localhost/api/panel/terminal-state?scope=repo-older', {
      method: 'POST',
      body: JSON.stringify({
        version: 1,
        activeTabId: 'global-shell',
        savedAt: '2026-09-24T00:00:00.000Z',
        tabs: [
          { id: 'global-shell', kind: 'terminal', label: 'Terminal 1', cliAgent: 'shell' },
          { id: 'retired-chat', kind: 'chat', label: 'Retired', cliAgent: 'codex', orchestrationPacket: { packetId: 'missing-packet' } },
        ],
      }),
    }));

    const restored = await GET(new Request(stateUrl));
    expect(restored.status).toBe(200);
    const state = await restored.json() as { tabs: Array<{ id: string }> };
    expect(state.tabs.map((tab) => tab.id)).toEqual(['global-shell']);
  });
});


describe('terminal state restore through repository aliases', () => {
  it.each(['global', 'canonical-request', 'alias-request'])('restores an alias-bound tab through %s', async (entry) => {
    const fixture = mkdtempSync(path.join(dataDir, 'restore-alias-'));
    try {
      const repoPath = path.join(fixture, 'repo');
      const aliasPath = path.join(fixture, 'alias');
      mkdirSync(repoPath);
      symlinkSync(repoPath, aliasPath, 'junction');
      writeFileSync(path.join(dataDir, 'repos.json'), JSON.stringify({ version: 1,
        repos: [{ id: 'registered', name: 'repo', localPath: repoPath }],
      }));
      await listReposFresh();
      const save = await POST(new Request(stateUrl, { method: 'POST', body: JSON.stringify({
        version: 1, activeTabId: 'cloud-review', tabs: [
          { id: 'cloud-review', kind: 'chat', label: 'Cloud review', chatRuntime: 'cloud', chatSessionKey: 'cloud:review', repoPath: aliasPath },
        ],
      }) }));
      expect(save.status).toBe(200);
      const requestUrl = entry === 'global' ? stateUrl
        : `http://localhost/api/panel/terminal-state?scope=repo-current&repoPath=${encodeURIComponent(entry === 'alias-request' ? aliasPath : repoPath)}`;
      const restored = await GET(new Request(requestUrl));
      expect(restored.status).toBe(200);
      expect(await restored.json()).toMatchObject({ activeTabId: 'cloud-review', tabs: [
        { id: 'cloud-review', chatSessionKey: 'cloud:review', repoPath: aliasPath },
      ] });
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('does not restore a tab whose path resolves outside the registered repository', async () => {
    const fixture = mkdtempSync(path.join(dataDir, 'restore-alias-'));
    try {
      const repoPath = path.join(fixture, 'repo');
      const outsidePath = path.join(fixture, 'outside');
      mkdirSync(repoPath);
      mkdirSync(outsidePath);
      const escapedPath = path.join(repoPath, 'outside-link');
      symlinkSync(outsidePath, escapedPath, 'junction');
      writeFileSync(path.join(dataDir, 'repos.json'), JSON.stringify({ version: 1,
        repos: [{ id: 'registered', name: 'repo', localPath: repoPath }],
      }));
      await listReposFresh();
      await POST(new Request(stateUrl, { method: 'POST', body: JSON.stringify({
        version: 1, activeTabId: 'global-shell', tabs: [
          { id: 'global-shell', kind: 'terminal', cliAgent: 'shell' },
          { id: 'escaped-repo', kind: 'chat', chatRuntime: 'cloud', chatSessionKey: 'cloud:other', repoPath: escapedPath },
        ],
      }) }));
      const restored = await GET(new Request(stateUrl));
      expect(restored.status).toBe(200);
      const state = await restored.json() as { tabs: Array<{ id: string }> };
      expect(state.tabs.map((tab) => tab.id)).toEqual(['global-shell']);
      const rejected = await GET(new Request(`${stateUrl}&repoPath=${encodeURIComponent(escapedPath)}`));
      expect(rejected.status).toBe(204);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
