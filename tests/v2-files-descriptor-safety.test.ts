import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const ORIGINAL_REPO_ROOT = process.env.CORTEX_IDE_REVIEW_REPO_ROOT;

let tempRoot = '';
let workspace = '';
let outside = '';

function request(url: string, init?: ConstructorParameters<typeof NextRequest>[1]) {
  return new NextRequest(url, init);
}

async function loadRoute() {
  return import('@/app/api/v2/files/route');
}

describe('/api/v2/files descriptor-anchored access', () => {
  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'o8-v2-files-descriptor-'));
    workspace = join(tempRoot, 'workspace');
    outside = join(tempRoot, 'outside');
    mkdirSync(workspace);
    mkdirSync(outside);
    process.env.CORTEX_IDE_REVIEW_REPO_ROOT = workspace;
    vi.resetModules();
  });

  afterEach(() => {
    if (ORIGINAL_REPO_ROOT === undefined) delete process.env.CORTEX_IDE_REVIEW_REPO_ROOT;
    else process.env.CORTEX_IDE_REVIEW_REPO_ROOT = ORIGINAL_REPO_ROOT;
    rmSync(tempRoot, { recursive: true, force: true });
    vi.resetModules();
  });

  it('reads and writes through the actual route handlers', async () => {
    writeFileSync(join(workspace, 'note.txt'), 'before\n', 'utf-8');
    const { GET, POST } = await loadRoute();

    const readResponse = await GET(request('http://localhost/api/v2/files?path=note.txt'));
    expect(readResponse.status).toBe(200);
    await expect(readResponse.json()).resolves.toMatchObject({
      content: 'before\n',
      path: 'note.txt',
      exists: true,
    });

    const writeResponse = await POST(request('http://localhost/api/v2/files', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'note.txt', content: 'after\n' }),
    }));
    expect(writeResponse.status).toBe(200);
    await expect(writeResponse.json()).resolves.toMatchObject({
      success: true,
      path: 'note.txt',
      isNew: false,
      oldContent: 'before\n',
    });
    expect(readFileSync(join(workspace, 'note.txt'), 'utf-8')).toBe('after\n');

    const createResponse = await POST(request('http://localhost/api/v2/files', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'created.txt', content: 'created\n' }),
    }));
    expect(createResponse.status).toBe(200);
    await expect(createResponse.json()).resolves.toMatchObject({
      success: true,
      path: 'created.txt',
      isNew: true,
      oldContent: null,
    });
    expect(readFileSync(join(workspace, 'created.txt'), 'utf-8')).toBe('created\n');
  });

  it('refuses a read symlink whose target is outside the workspace', async () => {
    const outsideFile = join(outside, 'secret.txt');
    writeFileSync(outsideFile, 'outside secret\n', 'utf-8');
    symlinkSync(outsideFile, join(workspace, 'escape.txt'));
    const { GET } = await loadRoute();

    const response = await GET(request('http://localhost/api/v2/files?path=escape.txt'));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: 'workspace_symlink_refused',
    });
  });

  it('refuses write-through-symlink and leaves the outside file unchanged', async () => {
    const outsideFile = join(outside, 'secret.txt');
    writeFileSync(outsideFile, 'outside secret\n', 'utf-8');
    symlinkSync(outsideFile, join(workspace, 'escape.txt'));
    const { POST } = await loadRoute();

    const response = await POST(request('http://localhost/api/v2/files', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'escape.txt', content: 'overwritten\n' }),
    }));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: 'workspace_symlink_refused',
    });
    expect(readFileSync(outsideFile, 'utf-8')).toBe('outside secret\n');
  });
});
