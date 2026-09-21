import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

const architectureDeltaRoute = await import('@/app/api/review/architecture-delta/route');
const fixturePaths = new Set<string>();

afterEach(() => {
  for (const fixturePath of fixturePaths) rmSync(fixturePath, { recursive: true, force: true });
  fixturePaths.clear();
});

function git(repoPath: string, args: string[]) {
  return execFileSync('git', args, {
    cwd: repoPath,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

function write(repoPath: string, relativePath: string, content: string) {
  const target = path.join(repoPath, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

function createRepo() {
  const repoPath = mkdtempSync(path.join(os.tmpdir(), 'o8-architecture-delta-'));
  fixturePaths.add(repoPath);
  git(repoPath, ['init', '-b', 'main']);
  git(repoPath, ['config', 'user.email', 'architecture-delta@example.test']);
  git(repoPath, ['config', 'user.name', 'Architecture Delta Test']);
  write(repoPath, 'tsconfig.json', JSON.stringify({
    compilerOptions: {
      baseUrl: '.',
      paths: { '@/*': ['src/*'] },
    },
  }));
  write(repoPath, 'src/feature.ts', "import { core } from '@/core';\nexport const feature = core;\n");
  write(repoPath, 'src/core.ts', 'export const core = 1;\n');
  write(repoPath, 'src/entry.ts', "import { feature } from './feature';\nexport const entry = feature;\n");
  write(repoPath, 'src/unrelated.ts', 'export const unrelated = true;\n');
  git(repoPath, ['add', 'tsconfig.json', 'src/feature.ts', 'src/core.ts', 'src/entry.ts', 'src/unrelated.ts']);
  git(repoPath, ['commit', '-m', 'test: seed architecture fixture']);
  return repoPath;
}

function requestFor(repoPath: string) {
  return new NextRequest(
    `http://localhost:3001/api/review/architecture-delta?workspace=${encodeURIComponent(repoPath)}`,
    { headers: { host: 'localhost:3001' } },
  );
}

describe('review architecture delta route', () => {
  it('compares the real working tree with HEAD and bounds the result to changed modules and neighbors', async () => {
    const repoPath = createRepo();
    write(repoPath, 'src/feature.ts', "import { nextCore } from '@/next-core';\nexport const feature = nextCore;\n");
    write(repoPath, 'src/next-core.ts', 'export const nextCore = 2;\n');

    const response = await architectureDeltaRoute.GET(requestFor(repoPath));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, status: 'ready', truncated: false });
    expect(body.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'src/feature.ts', state: 'changed', focusPath: 'src/feature.ts' }),
      expect.objectContaining({ path: 'src/core.ts', state: 'context', focusPath: null }),
      expect.objectContaining({ path: 'src/entry.ts', state: 'context', focusPath: null }),
      expect.objectContaining({ path: 'src/next-core.ts', state: 'added', focusPath: 'src/next-core.ts' }),
    ]));
    expect(body.nodes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'src/unrelated.ts' }),
    ]));
    expect(body.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'src/feature.ts', to: 'src/core.ts', state: 'removed' }),
      expect.objectContaining({ from: 'src/feature.ts', to: 'src/next-core.ts', state: 'added' }),
      expect.objectContaining({ from: 'src/entry.ts', to: 'src/feature.ts', state: 'context' }),
    ]));
  });

  it('reports an unsupported change set instead of presenting an empty graph as success', async () => {
    const repoPath = createRepo();
    write(repoPath, 'README.md', '# Documentation only\n');

    const response = await architectureDeltaRoute.GET(requestFor(repoPath));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      status: 'unsupported',
      reason: 'No supported source modules changed.',
      nodes: [],
      edges: [],
    });
    expect(body.unsupportedPaths).toContain('README.md');
  });
});
