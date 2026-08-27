import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import packageJson from '../package.json';

const originalDataDir = process.env.CORTEX_IDE_DATA_DIR;
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-shipped-dark-settings-'));
const repoPath = mkdtempSync(path.join(os.tmpdir(), 'o8-shipped-dark-repo-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const { auditShippedButDarkFlags } = await import('@/lib/operator/shipped-dark-audit');
const { OPERATOR_EXPERIMENTAL_OR_OPT_IN_FLAG_KEYS } = await import('@/lib/settings/toml');

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: repoPath, stdio: 'ignore' });
}

function commit(message: string): void {
  git('add', '.');
  git('commit', '-m', message);
}

function release(version: number): void {
  writeFileSync(path.join(repoPath, 'release.txt'), `${version}\n`);
  commit(`release ${version}`);
  git('tag', `v0.1.${version}`);
}

git('init');
git('config', 'user.email', 'audit-test@example.invalid');
git('config', 'user.name', 'Audit Test');
mkdirSync(path.join(repoPath, 'src/lib/operator'), { recursive: true });
writeFileSync(path.join(repoPath, 'src/lib/operator/defaults.ts'), [
  'export const defaults = {',
  '  experimentalChat: false,',
  '  nativeBrowserView: false,',
  '};',
  '',
].join('\n'));
writeFileSync(path.join(repoPath, 'src/lib/operator/broadcast-commentary-defaults.ts'), [
  'export const defaults = {',
  "  broadcastVoice: 'off',",
  '};',
  '',
].join('\n'));
commit('add opt-in flags');
git('tag', 'v0.1.10');
release(11);
release(12);
git('tag', '0.1.12');
writeFileSync(path.join(repoPath, 'src/lib/operator/defaults.ts'), [
  'export const defaults = {',
  '  experimentalChat: false,',
  '  nativeBrowserView: true,',
  '};',
  '',
].join('\n'));
commit('promote native browser view');
git('tag', 'v0.1.13');
release(14);

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.CORTEX_IDE_DATA_DIR;
  else process.env.CORTEX_IDE_DATA_DIR = originalDataDir;
  rmSync(dataDir, { force: true, recursive: true });
  rmSync(repoPath, { force: true, recursive: true });
});

describe.sequential('shipped-but-dark flag audit real path', () => {
  it('reads persisted settings, reports release age, and omits promoted flags', async () => {
    writeFileSync(path.join(dataDir, 'settings.toml'), [
      '[experimental]',
      'chat_enabled = false',
      'native_browser_view = false',
      '',
    ].join('\n'));

    const audit = await auditShippedButDarkFlags({ repoPath });
    const chat = audit.flags.find((flag) => flag.key === 'experimentalChat');

    expect(audit.currentRelease).toBe('v0.1.14');
    expect(audit.checkedFlags).toHaveLength(OPERATOR_EXPERIMENTAL_OR_OPT_IN_FLAG_KEYS.length);
    expect(chat).toMatchObject({
      tomlKey: 'experimental.chat_enabled',
      codeDefault: false,
      operatorValue: false,
      operatorValueSource: 'file',
      defaultFile: 'src/lib/operator/defaults.ts',
      landedRelease: 'v0.1.10',
      darkForReleases: 4,
    });
    expect(audit.flags.some((flag) => flag.key === 'nativeBrowserView')).toBe(false);
    expect(audit.flags.find((flag) => flag.key === 'broadcastVoice')).toMatchObject({
      codeDefault: 'off',
      operatorValue: 'off',
      operatorValueSource: 'default',
      defaultFile: 'src/lib/operator/broadcast-commentary-defaults.ts',
      landedRelease: 'v0.1.10',
      darkForReleases: 4,
    });

    writeFileSync(path.join(dataDir, 'settings.toml'), [
      '[experimental]',
      'chat_enabled = true',
      '',
    ].join('\n'));
    const promoted = await auditShippedButDarkFlags({ repoPath });
    expect(promoted.flags.some((flag) => flag.key === 'experimentalChat')).toBe(false);
  });

  it('runs the installed path without a Git checkout', async () => {
    writeFileSync(path.join(dataDir, 'settings.toml'), [
      '[experimental]',
      'chat_enabled = false',
      '',
    ].join('\n'));
    const originalCwd = process.cwd();
    process.chdir(dataDir);
    try {
      const audit = await auditShippedButDarkFlags();
      const currentPatch = Number.parseInt(packageJson.version.split('.')[2] ?? '', 10);
      expect(audit.currentRelease).toBe(packageJson.version);
      expect(audit.flags.find((flag) => flag.key === 'experimentalChat')).toMatchObject({
        landedRelease: '0.1.681',
        darkForReleases: currentPatch - 681,
      });
    } finally {
      process.chdir(originalCwd);
    }
  });
});
