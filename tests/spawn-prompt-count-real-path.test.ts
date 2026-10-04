/** Real spawn route -> mission persistence; only provider dispatch is held. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const cacheRoot = join(process.cwd(), 'node_modules', '.cache');
mkdirSync(cacheRoot, { recursive: true });
const dataDir = mkdtempSync(join(cacheRoot, 'o8-spawn-count-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;

const mocks = vi.hoisted(() => ({ preflight: vi.fn(), dispatch: vi.fn(), availableHeap: null as number | null }));
vi.mock('node:v8', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:v8')>();
  return {
    ...actual,
    getHeapStatistics: () => {
      const stats = actual.getHeapStatistics();
      return { ...stats, total_available_size: mocks.availableHeap ?? stats.total_available_size };
    },
  };
});
vi.mock('@/lib/runtimes/shared/auth-detect', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/runtimes/shared/auth-detect')>(),
  assertRuntimeDispatchable: mocks.preflight,
}));
vi.mock('@/lib/orchestrator/dispatch', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/orchestrator/dispatch')>(),
  runDispatchTick: mocks.dispatch,
}));

let repoPath: string;
beforeAll(() => {
  repoPath = mkdtempSync(join(dataDir, 'repo-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' });
  git('init', '--initial-branch=main');
  writeFileSync(join(repoPath, 'README.md'), 'spawn count fixture\n');
  git('add', 'README.md');
  git('-c', 'user.email=test@o8.test', '-c', 'user.name=o8-test', 'commit', '-m', 'init');
  mocks.dispatch.mockImplementation(async (state) => state);
});
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

async function spawn(body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/orchestrator/spawn-prompt/route');
  return POST(new NextRequest('http://localhost/api/orchestrator/spawn-prompt', {
    method: 'POST',
    headers: { host: 'localhost' },
    body: JSON.stringify({ repoPath, task: 'preserve every requested task', requestedRuntime: 'codex', clientMutationId: crypto.randomUUID(), ...body }),
  }));
}

describe('explicit spawn counts through the public route', () => {
  it.each([20, 50])('persists all %i requested packets without changing the saved parallel cap', async (count) => {
    const { updateOperatorDefaults, getOperatorDefaultsSync, getOperatorDefaultsTomlPath } = await import('@/lib/operator/defaults');
    await updateOperatorDefaults({ parallelCap: 5 });
    const defaultsBefore = readFileSync(getOperatorDefaultsTomlPath(), 'utf8');
    const response = await spawn({ count });
    expect(response.status).toBe(201);
    const json = await response.json() as { result: { missionId: string; packetIds: string[] } };
    expect(json.result.packetIds).toHaveLength(count);
    const { readMissionRegistryEntry } = await import('@/lib/orchestrator/mission-registry');
    const stored = readMissionRegistryEntry(json.result.missionId)!;
    expect(stored.mission.packets).toHaveLength(count);
    expect(new Set(stored.mission.packets.map((packet) => packet.id)).size).toBe(count);
    expect(stored.mission.packets.at(-1)?.title).toContain(`(${count}/${count})`);
    expect(getOperatorDefaultsSync().values.parallelCap).toBe(5);
    expect(readFileSync(getOperatorDefaultsTomlPath(), 'utf8')).toBe(defaultsBefore);
    expect(mocks.dispatch.mock.calls.at(-1)?.[0].packets).toHaveLength(count);
  });

  it('uses one packet only when count is omitted', async () => {
    const response = await spawn({});
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ result: { packetIds: [expect.any(String)] } });
  });

  it.each([null, '20', true, {}, [], 0, -1, 1.5, 1e100, Number.MAX_SAFE_INTEGER, 1_000_000_000].map((count) => [count]))('rejects count %j before any side effects', async (count) => {
    const { getSqlite } = await import('@/lib/db');
    const db = getSqlite();
    const beforeMissions = db.prepare('SELECT COUNT(*) AS n FROM missions').get();
    const beforeReceipts = db.prepare('SELECT COUNT(*) AS n FROM idempotency_keys').get();
    const beforePreflight = mocks.preflight.mock.calls.length;
    const beforeDispatch = mocks.dispatch.mock.calls.length;
    const response = await spawn({ count });
    expect(response.status).toBe(400);
    const code = typeof count === 'number' && Number.isSafeInteger(count) && count > 0
      ? 'resource_limit' : 'invalid_request';
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: { code, message: expect.any(String) } });
    expect(db.prepare('SELECT COUNT(*) AS n FROM missions').get()).toEqual(beforeMissions);
    expect(db.prepare('SELECT COUNT(*) AS n FROM idempotency_keys').get()).toEqual(beforeReceipts);
    expect(mocks.preflight).toHaveBeenCalledTimes(beforePreflight);
    expect(mocks.dispatch).toHaveBeenCalledTimes(beforeDispatch);
  });

  it.each([['task', 100], ['constraints', 150]] as const)('rejects repeated %s text exceeding serialization capacity even with ample heap', async (field, count) => {
    const { getSqlite } = await import('@/lib/db');
    const db = getSqlite();
    const beforeMissions = db.prepare('SELECT COUNT(*) AS n FROM missions').get();
    const beforeReceipts = db.prepare('SELECT COUNT(*) AS n FROM idempotency_keys').get();
    const beforePreflight = mocks.preflight.mock.calls.length;
    const beforeDispatch = mocks.dispatch.mock.calls.length;
    // Keep the repro bounded even on the broken guard: stop at preflight,
    // before it can allocate/persist a 600-million-character mission string.
    mocks.availableHeap = 64 * 1024 ** 3;
    mocks.preflight.mockImplementation(async () => { throw new Error('fixture stopped before giant allocation'); });
    try {
      const response = await spawn({ [field]: 'x'.repeat(2_000_000), count });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ ok: false, error: { code: 'resource_limit' } });
      expect(db.prepare('SELECT COUNT(*) AS n FROM missions').get()).toEqual(beforeMissions);
      expect(db.prepare('SELECT COUNT(*) AS n FROM idempotency_keys').get()).toEqual(beforeReceipts);
      expect(mocks.preflight).toHaveBeenCalledTimes(beforePreflight);
      expect(mocks.dispatch).toHaveBeenCalledTimes(beforeDispatch);
    } finally {
      mocks.availableHeap = null;
      mocks.preflight.mockReset();
    }
  });
});
