import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ context: vi.fn(), active: vi.fn() }));
vi.mock('node:fs', () => ({
  existsSync: () => true,
  readdirSync: () => ['selected.md', 'other.md', 'global.md'],
  readFileSync: (file: string) => {
    const name = file.split('/').pop()!.replace('.md', '');
    return `---\nid: ${name}\ntitle: ${name}\nscope: ${name === 'global' ? 'global' : 'project'}\nprojects: [${name}]\n---\n${name} guidance`;
  },
  mkdirSync: vi.fn(), writeFileSync: vi.fn(),
}));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => '/fixture' }));
vi.mock('@/lib/cortex/directive-merges', () => ({ readAllDirectiveTrailers: () => new Map() }));
vi.mock('@/lib/cortex/diagnostics', () => ({ withTimingSync: (_name: string, read: () => unknown) => read() }));
vi.mock('@/lib/db', () => ({ getSqlite: vi.fn() }));
vi.mock('@/lib/db/v14-fts5-migration', () => ({ refreshDirectiveFts: vi.fn() }));
vi.mock('@/lib/projects/context', () => ({ getProjectContext: mocks.context }));
vi.mock('@/lib/repos/projects', () => ({ getActiveProjectScopeForRepo: mocks.active }));
vi.mock('@/lib/repos/registry', () => ({ listRepos: vi.fn() }));
vi.mock('@/lib/projects/store', () => ({ listProjectsByRepoId: vi.fn() }));

import { GET } from './route';

describe('selected project directive inventory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.context.mockResolvedValue({
      id: 'selected-id', runtimeProjectId: 'selected-id', settingsProjectId: 'selected-id',
      slug: 'selected', repoInProject: true,
    });
    mocks.active.mockResolvedValue({ projectId: 'other-id', projectSlug: 'other', repoInActiveProject: true });
  });

  it('uses the requested project for a shared repository rather than the active project', async () => {
    const response = await GET(new NextRequest('http://localhost/api/cortex/directives?projectId=selected-id&repoPath=%2Frepos%2Fweb'));
    expect(response.status).toBe(200);
    expect((await response.json()).directives.map((entry: { id: string }) => entry.id).sort()).toEqual(['global', 'selected']);
    expect(mocks.context).toHaveBeenCalledWith({ projectId: 'selected-id', repoPath: '/repos/web' });
    expect(mocks.active).not.toHaveBeenCalled();
  });

  it('keeps legacy callers scoped to the active project', async () => {
    const response = await GET(new NextRequest('http://localhost/api/cortex/directives?repoPath=%2Frepos%2Fweb'));
    expect((await response.json()).directives.map((entry: { id: string }) => entry.id).sort()).toEqual(['global', 'other']);
    expect(mocks.context).not.toHaveBeenCalled();
  });
});
