import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';

import { extractRoughdraftReviewIndex } from '@/lib/o8md/rfm';
import * as repoSpecRoute from '@/app/api/repo-spec/route';

function request(repoPath: string, content: string): NextRequest {
  return new NextRequest(`http://localhost:3001/api/repo-spec?repoPath=${encodeURIComponent(repoPath)}`, {
    method: 'PUT',
    headers: { host: 'localhost:3001', 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  });
}

describe('repo-spec PUT orphaned annotation cleanup', () => {
  it('removes an empty-anchor comment thread through the real route write path', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'o8-repo-spec-cleanup-'));
    const orphaned = [
      'Keep ',
      '{====}{>>stale right-rail note<<}{id="c1" by="AI" at="2026-07-03T12:00:00.000Z"}',
      '{>>operator reply<<}{id="c2" by="user" at="2026-07-03T12:01:00.000Z" re="c1"}',
      ' text',
    ].join('');

    const res = await repoSpecRoute.PUT(request(repoPath, orphaned));
    const json = await res.json();
    const written = readFileSync(join(repoPath, 'o8.md'), 'utf-8');

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.orphanedAnnotationsRemoved).toBe(2);
    expect(json.content).toBe('Keep  text');
    expect(written).toBe('Keep  text');
    expect(extractRoughdraftReviewIndex(written).items).toHaveLength(0);
  });

  it('preserves live anchored and standalone notes while removing only lost anchors', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'o8-repo-spec-cleanup-'));
    const content = [
      '{==live words==}{>>keep anchored<<}{id="c1" by="AI" at="2026-07-03T12:00:00.000Z"}',
      '\n{====}{>>drop orphan<<}{id="c2" by="AI" at="2026-07-03T12:01:00.000Z"}',
      '\n{>>keep standalone<<}{id="c3" by="AI" at="2026-07-03T12:02:00.000Z"}',
    ].join('');

    const res = await repoSpecRoute.PUT(request(repoPath, content));
    const written = readFileSync(join(repoPath, 'o8.md'), 'utf-8');
    const ids = extractRoughdraftReviewIndex(written).items.map((item) => item.id);

    expect(res.status).toBe(200);
    expect(written).toContain('live words');
    expect(written).toContain('keep anchored');
    expect(written).not.toContain('drop orphan');
    expect(written).toContain('keep standalone');
    expect(ids).toEqual(['c1', 'c3']);
  });

  it('removes empty operator-side suggestions through the real route write path', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'o8-repo-spec-cleanup-'));
    const content = [
      'A {~~~>replacement~~}{id="s1" by="AI" at="2026-07-03T12:00:00.000Z"}',
      ' B {==still here==}{>>keep note<<}{id="c1" by="AI" at="2026-07-03T12:01:00.000Z"}',
    ].join('');
    writeFileSync(join(repoPath, 'o8.md'), content, 'utf-8');

    const res = await repoSpecRoute.PUT(request(repoPath, content));
    const written = readFileSync(join(repoPath, 'o8.md'), 'utf-8');
    const index = extractRoughdraftReviewIndex(written);

    expect(res.status).toBe(200);
    expect(written).not.toContain('replacement');
    expect(index.items.map((item) => item.id)).toEqual(['c1']);
  });
});
