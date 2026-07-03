import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const REAL_HOME = process.env.HOME;

let tmpHome = '';

async function loadFilesRoute() {
  return import('@/app/api/v2/files/route');
}

function request(url: string, init?: ConstructorParameters<typeof NextRequest>[1]) {
  return new NextRequest(url, init);
}

describe('/api/v2/files operator config allowlist', () => {
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'o8-files-home-'));
    process.env.HOME = tmpHome;
    vi.resetModules();
  });

  afterEach(() => {
    if (REAL_HOME === undefined) delete process.env.HOME;
    else process.env.HOME = REAL_HOME;
    rmSync(tmpHome, { recursive: true, force: true });
    vi.resetModules();
  });

  it('rejects non-allowlisted absolute paths through the real GET handler', async () => {
    const sshConfig = join(tmpHome, '.ssh', 'config');
    mkdirSync(join(tmpHome, '.ssh'), { recursive: true });
    writeFileSync(sshConfig, 'Host *\n  AddKeysToAgent yes\n', 'utf-8');

    const { GET } = await loadFilesRoute();
    const res = await GET(request(`http://localhost/api/v2/files?path=${encodeURIComponent(sshConfig)}`));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toMatchObject({
      error: 'Absolute path is not allowlisted',
      code: 'absolute_path_not_allowlisted',
    });
  });

  it('reads and saves an allowlisted global CLAUDE.md through the real route handlers', async () => {
    const claudeDir = join(tmpHome, '.claude');
    const claudePath = join(claudeDir, 'CLAUDE.md');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(claudePath, '# operator notes\n', 'utf-8');

    const { GET, POST } = await loadFilesRoute();
    const getRes = await GET(request(`http://localhost/api/v2/files?path=${encodeURIComponent(claudePath)}`));
    const getBody = await getRes.json();

    expect(getRes.status).toBe(200);
    expect(getBody).toMatchObject({
      content: '# operator notes\n',
      path: claudePath,
      exists: true,
    });

    const postRes = await POST(request('http://localhost/api/v2/files', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: claudePath, content: '# updated notes\n' }),
    }));
    const postBody = await postRes.json();

    expect(postRes.status).toBe(200);
    expect(postBody).toMatchObject({ success: true, path: claudePath, isNew: false });
    expect(readFileSync(claudePath, 'utf-8')).toBe('# updated notes\n');
  });
});
