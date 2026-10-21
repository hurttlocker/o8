import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { readFile } = vi.hoisted(() => ({ readFile: vi.fn() }));
vi.mock('node:fs/promises', () => ({ readFile }));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => '/tmp/dev-sidebar-fixture-test' }));
import { GET } from './route';

const payload = { schema: 'o8/ui-sidebar-fixtures/v1', synthetic: true, fixtures: [{
  tabId: 'thoughts-sidebar-demo-test-merged', title: 'Demo · Merged', state: 'merged', scheduled: false,
  repoName: 'project', repoPath: '/tmp/project', branch: 'demo/layout', preview: 'Synthetic merged sample',
  updatedAt: '2026-10-08T21:00:00.000Z',
}] };

describe('private development sidebar samples entry point', () => {
  beforeEach(() => { vi.stubEnv('NODE_ENV', 'development'); readFile.mockReset(); });
  afterEach(() => vi.unstubAllEnvs());
  it('reads only the fixed display file from the current data directory', async () => {
    readFile.mockResolvedValue(JSON.stringify(payload));
    const response = await GET();
    expect(await response.json()).toEqual(payload);
    expect(readFile).toHaveBeenCalledWith('/tmp/dev-sidebar-fixture-test/ui-sidebar-fixtures.json', 'utf8');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it('does not read fixture data in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect((await GET()).status).toBe(404);
    expect(readFile).not.toHaveBeenCalled();
  });
  it('leaves an ordinary development app empty when no samples were seeded', async () => {
    readFile.mockRejectedValue(Object.assign(new Error('Absent'), { code: 'ENOENT' }));
    expect(await (await GET()).json()).toEqual({ schema: payload.schema, synthetic: true, fixtures: [] });
  });
  it.each([
    { ...payload, synthetic: false },
    { ...payload, fixtures: [{ ...payload.fixtures[0], tabId: 'thoughts-real-user' }] },
    { ...payload, fixtures: [payload.fixtures[0], payload.fixtures[0]] },
  ])('rejects non-synthetic or ambiguous fixture records', async (invalid) => {
    readFile.mockResolvedValue(JSON.stringify(invalid));
    const response = await GET();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Unable to read sidebar samples' });
  });
});
