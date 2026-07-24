import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

const testRoot = mkdtempSync(join(tmpdir(), 'o8-mobile-first-thread-'));
process.env.CORTEX_IDE_DATA_DIR = testRoot;

const { POST } = await import('@/app/api/mobile/orchestrator/threads/route');
const {
  createMobileOrchestratorThreadFromRepo,
} = await import('@/lib/mobile/orchestrator-thread-create');
const {
  listMobileOrchestratorThreads,
} = await import('@/lib/mobile/orchestrator-thread-history');

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

describe('mobile first orchestrator conversation', () => {
  it('creates and routes a first thread from an explicit repository choice', async () => {
    expect(listMobileOrchestratorThreads()).toEqual([]);

    const thread = await createMobileOrchestratorThreadFromRepo({
      repoPath: '/tmp/repos/first-mobile-repo',
      repoName: 'First mobile repo',
      repoBranch: 'main',
    }, {
      token: 'mobile-test-token',
      fetchImpl: async (input, init) => POST(new NextRequest(`http://localhost${input}`, {
        method: init.method,
        headers: init.headers,
        body: init.body,
      })),
    });

    expect(thread).toMatchObject({
      id: expect.stringMatching(/^thoughts-/),
      repoPath: '/tmp/repos/first-mobile-repo',
      repoName: 'First mobile repo',
      repoBranch: 'main',
      status: 'idle',
    });
    expect(listMobileOrchestratorThreads()).toEqual([
      expect.objectContaining({
        id: thread.id,
        repoPath: '/tmp/repos/first-mobile-repo',
      }),
    ]);
  });
});
