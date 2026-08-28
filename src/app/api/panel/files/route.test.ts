import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GET } from './route';

describe('/api/panel/files listing modes', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'o8-panel-files-'));
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, '.git'));
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'README.md'), '# repo\n', 'utf-8');
    writeFileSync(join(root, 'src', 'index.ts'), 'export {};\n', 'utf-8');
    writeFileSync(join(root, 'node_modules', 'ignored.js'), 'ignored\n', 'utf-8');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('lists one directory at a time and marks ignored directories', async () => {
    const params = new URLSearchParams({ workspace: root, directory: '' });
    const response = await GET(new Request(`http://localhost/api/panel/files?${params.toString()}`));
    expect(response.status).toBe(200);
    const payload = await response.json() as { entries: Array<{ name: string; kind: string; ignored?: boolean }> };

    expect(payload.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'src', kind: 'directory' }),
      expect.objectContaining({ name: '.git', kind: 'directory', ignored: true }),
      expect.objectContaining({ name: 'node_modules', kind: 'directory', ignored: true }),
      expect.objectContaining({ name: 'README.md', kind: 'file' }),
    ]));
  });

  it('returns recursive files without walking ignored directories', async () => {
    const params = new URLSearchParams({ workspace: root, recursive: 'files' });
    const response = await GET(new Request(`http://localhost/api/panel/files?${params.toString()}`));
    expect(response.status).toBe(200);
    const payload = await response.json() as { entries: Array<{ path: string }> };
    const paths = payload.entries.map((entry) => entry.path);

    expect(paths).toContain('README.md');
    expect(paths).toContain(join('src', 'index.ts'));
    expect(paths).not.toContain(join('node_modules', 'ignored.js'));
  });

  it('refuses a directory outside the workspace', async () => {
    const params = new URLSearchParams({ workspace: root, directory: '..' });
    const response = await GET(new Request(`http://localhost/api/panel/files?${params.toString()}`));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 'directory_outside_workspace' });
  });
});
