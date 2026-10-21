import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GET } from './route';

describe('workspace explorer through a real Git directory', () => {
  let workspace: string;
  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'o8-explorer-git-'));
    execFileSync('git', ['init', '--quiet', workspace]);
    await writeFile(join(workspace, '.gitignore'), '.env.local\n.claude-worktrees/\n*.tsbuildinfo\n');
  });
  afterEach(async () => { await rm(workspace, { recursive: true, force: true }); });
  const read = (root: string, options: Record<string, string>) => GET(new Request(`http://localhost/api/panel/files?${new URLSearchParams({ workspace: root, ...options })}`));

  it('keeps dotfiles and project folders while annotating actual ignore rules', async () => {
    await mkdir(join(workspace, '.claude-worktrees')); await mkdir(join(workspace, '.vercel'));
    await writeFile(join(workspace, '.env.local'), 'fixture only');
    await writeFile(join(workspace, 'tsconfig.tsbuildinfo'), 'fixture only');
    await writeFile(join(workspace, 'CLAUDE.md'), '# Instructions');
    const response = await read(workspace, { directory: '.' });
    const result = await response.json();
    expect(response.status).toBe(200);
    expect(result.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '.claude-worktrees', kind: 'directory', ignored: true }),
      expect.objectContaining({ path: '.vercel', kind: 'directory' }),
      expect.objectContaining({ path: '.env.local', kind: 'file', ignored: true }),
      expect.objectContaining({ path: 'tsconfig.tsbuildinfo', ignored: true }),
      expect.objectContaining({ path: 'CLAUDE.md', kind: 'file' }),
    ]));
    expect(result.entries.some((entry: { path: string }) => entry.path === '.git')).toBe(false);
  });

  it('searches deep paths with spaces without walking ignored trees', async () => {
    await mkdir(join(workspace, 'src/deep/space names'), { recursive: true });
    await mkdir(join(workspace, '.claude-worktrees/deep'), { recursive: true });
    await writeFile(join(workspace, 'src/deep/space names/needle [test].tsx'), 'export {};');
    await writeFile(join(workspace, '.claude-worktrees/deep/needle.tsx'), 'export {};');
    const response = await read(workspace, { search: 'NEEDLE tsx' });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ entries: [{ name: 'needle [test].tsx', path: 'src/deep/space names/needle [test].tsx', kind: 'file' }], truncated: false });
  });

  it('caps matches and tells the caller to refine its search', async () => {
    await Promise.all(Array.from({ length: 502 }, (_, i) => writeFile(join(workspace, `match-${i}.ts`), '')));
    const response = await read(workspace, { search: 'match-' });
    const result = await response.json();
    expect(result.entries).toHaveLength(500); expect(result.truncated).toBe(true);
  });

  it('refuses a symlink that points outside the selected workspace', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'o8-explorer-outside-'));
    try {
      await writeFile(join(outside, 'outside.txt'), 'fixture');
      await symlink(outside, join(workspace, 'linked'), 'dir');
      const response = await read(workspace, { directory: 'linked' });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ code: 'directory_outside_workspace' });
    } finally { await rm(outside, { recursive: true, force: true }); }
  });

  it('allows a normal folder name starting with two dots', async () => {
    await mkdir(join(workspace, '..notes')); await writeFile(join(workspace, '..notes/visible.md'), '# Visible');
    const response = await read(workspace, { directory: '..notes' });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ entries: [{ path: '..notes/visible.md' }] });
  });
});
