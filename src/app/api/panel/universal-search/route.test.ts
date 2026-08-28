import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GET } from './route';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixtureRepo(): string {
  const repoPath = mkdtempSync(path.join(tmpdir(), 'o8-universal-search-route-'));
  tempDirs.push(repoPath);
  execFileSync('git', ['init', '--quiet'], { cwd: repoPath });
  mkdirSync(path.join(repoPath, 'src'));
  return repoPath;
}

describe('GET /api/panel/universal-search', () => {
  it('finds content that exists only inside an unopened repository file', async () => {
    const repoPath = fixtureRepo();
    const unopenedPath = path.join(repoPath, 'src', 'unopened-only.ts');
    writeFileSync(unopenedPath, 'export const canvasRouteOnlyUnopenedNeedle = true;\n');

    const params = new URLSearchParams({
      q: 'canvasRouteOnlyUnopenedNeedle',
      workspace: repoPath,
      categories: 'file',
    });
    const response = await GET(new Request(`http://localhost/api/panel/universal-search?${params.toString()}`));

    expect(response.status).toBe(200);
    const payload = await response.json() as {
      results: Array<{ kind: string; detail: string; target?: { filePath?: string } }>;
      categories: string[];
    };
    expect(payload.categories).toEqual(['file']);
    expect(payload.results).toContainEqual(expect.objectContaining({
      kind: 'file',
      detail: expect.stringContaining('canvasRouteOnlyUnopenedNeedle'),
      target: expect.objectContaining({ filePath: 'src/unopened-only.ts' }),
    }));
  });
});
