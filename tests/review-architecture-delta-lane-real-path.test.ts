import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

const root = mkdtempSync(path.join(os.tmpdir(), 'o8-architecture-lane-'));
const dataDir = path.join(root, 'data');
const repoPath = path.join(root, 'repo');
const operatorBearer = 'architecture-operator-fixture-bearer-0123456789abcdef';
mkdirSync(dataDir, { recursive: true });
mkdirSync(repoPath, { recursive: true });
writeFileSync(path.join(dataDir, 'ws-token'), `${operatorBearer}\n`, 'utf8');
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

function git(...args: string[]) {
  return execFileSync('git', args, { cwd: repoPath, encoding: 'utf8' }).trim();
}

git('init', '-q', '-b', 'main');
git('config', 'user.email', 'architecture-lane@example.test');
git('config', 'user.name', 'Architecture Lane Test');
writeFileSync(path.join(repoPath, 'tsconfig.json'), JSON.stringify({
  compilerOptions: { paths: { '@/*': ['./src/*'] } },
}));
mkdirSync(path.join(repoPath, 'src'), { recursive: true });
writeFileSync(path.join(repoPath, 'src/core.ts'), 'export const core = 1;\n');
writeFileSync(path.join(repoPath, 'src/feature.ts'), "import { core } from '@/core';\nexport const feature = core;\n");
git('add', '.');
git('commit', '-qm', 'test: seed lane architecture');
const baseCommit = git('rev-parse', 'HEAD');

const { closeDb } = await import('@/lib/db');
const { mintPacketWorkerToken } = await import('@/lib/auth/packet-worker-token');
const { createLane } = await import('@/lib/lane/registry');
const { addRepo } = await import('@/lib/repos/registry');
const { panelGateMiddleware } = await import('@/middleware');
const { GET } = await import('@/app/api/review/architecture-delta/route');

await addRepo(repoPath);
const packetId = 'packet-architecture-real-path';
const lane = createLane({
  repoPath,
  worktreePath: repoPath,
  branch: 'main',
  baseBranch: 'main',
  baseCommit,
  runtime: 'codex',
  packetId,
  ownership: 'managed',
});
writeFileSync(path.join(repoPath, 'src/next-core.ts'), 'export const nextCore = 2;\n');
writeFileSync(
  path.join(repoPath, 'src/feature.ts'),
  "import { nextCore } from '@/next-core';\nexport const feature = nextCore;\n",
);

function request(token: string) {
  return new NextRequest(`http://o8.remote/api/review/architecture-delta?lane=${lane.id}`, {
    headers: {
      authorization: `Bearer ${token}`,
      host: 'o8.remote',
      'x-o8-client-addr': '192.0.2.10',
    },
  });
}

afterAll(() => {
  closeDb();
  rmSync(root, { recursive: true, force: true });
});

describe('architecture delta persisted lane entry point', () => {
  it('survives a registry reopen and serves the materialized lane only to the operator', async () => {
    closeDb();
    const operatorRequest = request(operatorBearer);
    expect(panelGateMiddleware(operatorRequest).headers.get('x-middleware-next')).toBe('1');

    const response = await GET(operatorRequest);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, status: 'ready' });
    expect(body.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'src/feature.ts', to: 'src/core.ts', state: 'removed' }),
      expect.objectContaining({ from: 'src/feature.ts', to: 'src/next-core.ts', state: 'added' }),
    ]));

    const workerToken = mintPacketWorkerToken(packetId);
    const workerGate = panelGateMiddleware(request(workerToken));
    expect(workerGate.status).toBe(403);
    await expect(workerGate.json()).resolves.toMatchObject({
      error: 'Worker token is not authorized for this endpoint.',
    });
  });
});
