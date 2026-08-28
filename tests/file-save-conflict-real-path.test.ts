import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contentHash } from '@/lib/markdown/transport';

const ORIGINAL_REPO_ROOT = process.env.CORTEX_IDE_REVIEW_REPO_ROOT;

let repoPath = '';

function request(url: string, method = 'GET', body?: Record<string, unknown>) {
  return new NextRequest(url, {
    method,
    ...(body ? {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    } : {}),
  });
}

describe('content-hash file-save conflicts through the real routes', () => {
  beforeEach(() => {
    repoPath = mkdtempSync(join(tmpdir(), 'o8-file-save-conflict-'));
    process.env.CORTEX_IDE_REVIEW_REPO_ROOT = repoPath;
    vi.resetModules();
  });

  afterEach(() => {
    if (ORIGINAL_REPO_ROOT === undefined) delete process.env.CORTEX_IDE_REVIEW_REPO_ROOT;
    else process.env.CORTEX_IDE_REVIEW_REPO_ROOT = ORIGINAL_REPO_ROOT;
    rmSync(repoPath, { recursive: true, force: true });
    vi.resetModules();
  });

  it('hashes the full file-content read even when the response is truncated', async () => {
    const smallContent = 'small file\n';
    const largeContent = `${'x'.repeat(100001)}\nfull-file-tail`;
    writeFileSync(join(repoPath, 'small.md'), smallContent, 'utf-8');
    writeFileSync(join(repoPath, 'large.md'), largeContent, 'utf-8');
    const { GET } = await import('@/app/api/panel/file-content/route');

    const small = await GET(request('http://localhost/api/panel/file-content?path=small.md'));
    const smallBody = await small.json();
    expect(small.status).toBe(200);
    expect(smallBody.content).toBe(smallContent);
    expect(smallBody.contentHash).toBe(await contentHash(smallContent));

    const large = await GET(request('http://localhost/api/panel/file-content?path=large.md'));
    const largeBody = await large.json();
    expect(large.status).toBe(200);
    expect(largeBody.truncated).toBe(true);
    expect(largeBody.content).toBe(`${largeContent.slice(0, 100000)}\n\n... (truncated at 100KB)`);
    expect(largeBody.contentHash).toBe(await contentHash(largeContent));
    expect(largeBody.contentHash).not.toBe(await contentHash(largeBody.content));
  });

  it('guards v2 file saves while preserving force and legacy writes', async () => {
    const filePath = join(repoPath, 'note.md');
    writeFileSync(filePath, 'v2 before\n', 'utf-8');
    const { GET, POST } = await import('@/app/api/v2/files/route');

    const loaded = await GET(request('http://localhost/api/v2/files?path=note.md'));
    const loadedBody = await loaded.json();
    const h1 = loadedBody.contentHash as string;
    expect(loaded.status).toBe(200);
    expect(loadedBody.content).toBe('v2 before\n');
    expect(h1).toBe(await contentHash('v2 before\n'));

    const guarded = await POST(request('http://localhost/api/v2/files', 'POST', {
      path: 'note.md',
      content: 'v2 guarded\n',
      expectedHash: h1,
    }));
    const guardedBody = await guarded.json();
    const h2 = guardedBody.contentHash as string;
    expect(guarded.status).toBe(200);
    expect(h2).toBe(await contentHash('v2 guarded\n'));
    expect(h2).not.toBe(h1);
    expect(readFileSync(filePath, 'utf-8')).toBe('v2 guarded\n');

    writeFileSync(filePath, 'v2 external\n', 'utf-8');
    const stale = await POST(request('http://localhost/api/v2/files', 'POST', {
      path: 'note.md',
      content: 'v2 stale\n',
      expectedHash: h2,
    }));
    const staleBody = await stale.json();
    expect(stale.status).toBe(409);
    expect(staleBody).toMatchObject({
      error: 'changed-on-disk',
      content: 'v2 external\n',
    });
    expect(staleBody.contentHash).toBe(await contentHash('v2 external\n'));
    expect(staleBody.contentHash).not.toBe(h2);
    expect(readFileSync(filePath, 'utf-8')).toBe('v2 external\n');

    const forced = await POST(request('http://localhost/api/v2/files', 'POST', {
      path: 'note.md',
      content: 'v2 forced\n',
      expectedHash: h2,
      force: true,
    }));
    const forcedBody = await forced.json();
    expect(forced.status).toBe(200);
    expect(forcedBody.contentHash).toBe(await contentHash('v2 forced\n'));
    expect(readFileSync(filePath, 'utf-8')).toBe('v2 forced\n');

    const legacy = await POST(request('http://localhost/api/v2/files', 'POST', {
      path: 'note.md',
      content: 'v2 legacy\n',
    }));
    const legacyBody = await legacy.json();
    expect(legacy.status).toBe(200);
    expect(legacyBody.contentHash).toBe(await contentHash('v2 legacy\n'));
    expect(readFileSync(filePath, 'utf-8')).toBe('v2 legacy\n');
  });

  it('guards repo-spec saves while preserving force and legacy writes', async () => {
    const specPath = join(repoPath, 'o8.md');
    const routeUrl = `http://localhost/api/repo-spec?repoPath=${encodeURIComponent(repoPath)}`;
    writeFileSync(specPath, 'spec before\n', 'utf-8');
    const { GET, PUT } = await import('@/app/api/repo-spec/route');

    const loaded = await GET(request(routeUrl));
    const loadedBody = await loaded.json();
    const h1 = loadedBody.contentHash as string;
    expect(loaded.status).toBe(200);
    expect(loadedBody.content).toBe('spec before\n');
    expect(h1).toBe(await contentHash('spec before\n'));

    const guarded = await PUT(request(routeUrl, 'PUT', {
      content: 'spec guarded\n',
      expectedHash: h1,
    }));
    const guardedBody = await guarded.json();
    const h2 = guardedBody.contentHash as string;
    expect(guarded.status).toBe(200);
    expect(h2).toBe(await contentHash('spec guarded\n'));
    expect(h2).not.toBe(h1);
    expect(readFileSync(specPath, 'utf-8')).toBe('spec guarded\n');

    writeFileSync(specPath, 'spec external\n', 'utf-8');
    const stale = await PUT(request(routeUrl, 'PUT', {
      content: 'spec stale\n',
      expectedHash: h2,
    }));
    const staleBody = await stale.json();
    expect(stale.status).toBe(409);
    expect(staleBody).toMatchObject({
      error: 'changed-on-disk',
      content: 'spec external\n',
    });
    expect(staleBody.contentHash).toBe(await contentHash('spec external\n'));
    expect(staleBody.contentHash).not.toBe(h2);
    expect(readFileSync(specPath, 'utf-8')).toBe('spec external\n');

    const forced = await PUT(request(routeUrl, 'PUT', {
      content: 'spec forced\n',
      expectedHash: h2,
      force: true,
    }));
    const forcedBody = await forced.json();
    expect(forced.status).toBe(200);
    expect(forcedBody.contentHash).toBe(await contentHash('spec forced\n'));
    expect(readFileSync(specPath, 'utf-8')).toBe('spec forced\n');

    const legacy = await PUT(request(routeUrl, 'PUT', {
      content: 'spec legacy\n',
    }));
    const legacyBody = await legacy.json();
    expect(legacy.status).toBe(200);
    expect(legacyBody.contentHash).toBe(await contentHash('spec legacy\n'));
    expect(readFileSync(specPath, 'utf-8')).toBe('spec legacy\n');
  });
});
