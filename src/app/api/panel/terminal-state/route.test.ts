import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { GET, POST } from './route';
import { listReposFresh } from '@/lib/repos/registry';

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
