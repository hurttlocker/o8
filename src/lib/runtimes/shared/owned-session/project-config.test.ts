import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { backingProjectConfigPaths } from './project-config';

const fixtures: string[] = [];
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'o8-project-config-')));
  fixtures.push(root);
  const project = path.join(root, 'project');
  const configDir = path.join(project, '.codex');
  await mkdir(configDir, { recursive: true });
  return { root, project, configDir, config: path.join(configDir, 'config.toml'),
    gitPaths: [path.join(project, '.git', 'worktrees', 'packet'), path.join(project, '.git')] };
}
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('backing project configuration is an exact read-only input', () => {
  it('does not infer a project from a separate Git directory or reopen the current checkout', async () => {
    const f = await fixture();
    await expect(backingProjectConfigPaths([path.join(f.root, 'bare.git')], 'packet', []))
      .resolves.toEqual([]);
    await expect(backingProjectConfigPaths(f.gitPaths, f.project, [])).resolves.toEqual([]);
  });

  it('grants only an existing regular config and refuses protected project roots', async () => {
    const f = await fixture();
    await expect(backingProjectConfigPaths(f.gitPaths, 'packet', [])).resolves.toEqual([]);
    await writeFile(f.config, '# synthetic config');
    await expect(backingProjectConfigPaths(f.gitPaths, 'packet', [])).resolves.toEqual([f.config]);
    await expect(backingProjectConfigPaths(f.gitPaths, 'packet', [f.project])).rejects.toThrow('protected');
  });

  it.each(['file', 'parent', 'directory'] as const)('refuses a %s alias or directory grant', async (kind) => {
    const f = await fixture();
    const outside = path.join(f.root, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'config.toml'), '# synthetic private config');
    if (kind === 'parent') {
      await rm(f.configDir, { recursive: true });
      await symlink(outside, f.configDir);
    } else if (kind === 'file') {
      await symlink(path.join(outside, 'config.toml'), f.config);
    } else {
      await mkdir(f.config);
    }
    await expect(backingProjectConfigPaths(f.gitPaths, 'packet', [])).rejects.toThrow('non-aliased');
  });
});
