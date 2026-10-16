import 'server-only';

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { getDataDir } from '@/lib/data-dir-migration';
import { getUpdateIdleWindow } from '@/lib/app-update/idle-window';
import { compareCliVersions, invalidateCliCache, resolveCli } from '@/lib/runtimes/shared/cli-resolver';
import { checkCliUpdates } from './cli-updates';
import { inspectCliInstallation, requireUserOwned, type StableCli } from './cli-installation';
import { CodexUpdateRefusal, updateSelectedCodex } from './codex-cli-update';

const run = promisify(execFile);
const specs = {
  codex: { runtimeId: 'codex', binaryName: 'codex', envOverride: 'O8_CODEX_BIN' },
  'claude-code': { runtimeId: 'claude-code', binaryName: 'claude', envOverride: 'O8_CLAUDE_CODE_BIN', extraEnvOverrides: ['CLAUDE_BIN'] },
  grok: { runtimeId: 'grok', binaryName: 'grok', envOverride: 'O8_GROK_BIN', versionArgs: ['--no-auto-update', '--version'] },
};

async function requireIdle(runtime: StableCli, selectedPath: string, binary: string) {
  const inventory = await getUpdateIdleWindow();
  const commandName = runtime === 'codex' ? 'codex' : runtime === 'claude-code' ? 'claude' : 'grok';
  const matches = (command: string | null) => Boolean(command && new RegExp(`(?:^|[\\s/])${commandName}(?:\\s|$)`).test(command));
  if (inventory.unavailable.length || inventory.active.lanes.some(lane => lane.runtime === runtime)
    || inventory.active.ownedSessions.some(session => session.surfaceId.startsWith(runtime) || session.surfaceId.startsWith(commandName))
    || inventory.active.managedRuns.some(item => matches(item.command))
    || inventory.active.terminalSessions.some(item => matches(item.commandHint))) {
    throw new CodexUpdateRefusal('runtime-busy', `Wait for running ${commandName} sessions to finish. No sessions were stopped.`);
  }
  try {
    const { stdout } = await run('/bin/ps', ['-axo', 'comm=,args='], { timeout: 3_000, maxBuffer: 1024 * 1024 });
    if (stdout.split('\n').some(line => path.basename(line.trim().split(/\s+/)[0] ?? '') === commandName
      || line.includes(selectedPath) || line.includes(binary))) throw new Error('Runtime active.');
  } catch {
    throw new CodexUpdateRefusal('runtime-busy', `Running ${commandName} processes could not be ruled out. Wait and check again. No sessions were stopped.`);
  }
}

/** Fixed provider allowlist and original installer only. Never install a missing CLI. */
export async function updateSelectedStableCli(runtime: StableCli) {
  const spec = specs[runtime];
  invalidateCliCache(runtime);
  const selected = await resolveCli(spec);
  const installation = await inspectCliInstallation(runtime, selected);
  if (runtime === 'codex' && (installation.manager === 'npm' || installation.manager === 'manual')) return updateSelectedCodex();
  if (installation.manager === 'manual') throw new CodexUpdateRefusal('manual-update', 'Use the selected installation’s original package manager, then check again. Custom paths and version-manager shims are kept unchanged.');
  if (runtime === 'grok' && installation.manager === 'npm') {
    throw new CodexUpdateRefusal('manual-update', 'Use Grok Build’s original npm updater, then check again. Its package requires its own native installation step.');
  }
  const directory = getDataDir();
  await mkdir(directory, { recursive: true });
  const lockPath = path.join(directory, `${runtime}-cli-update.lock`);
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); } catch {
    throw new CodexUpdateRefusal('update-in-progress', 'This CLI already has an update in progress.');
  }
  const receiptPath = path.join(directory, `${runtime}-cli-update.json`);
  let receipt: { runtime: string; status: string; selectedPath: string; manager: string; targetVersion: string; startedAt: string; finishedAt?: string } | undefined;
  try {
    const tool = (await checkCliUpdates(true, runtime))[0];
    if (tool?.status !== 'update-available' || tool.selectedPath !== selected.path || !tool.latestVersion
      || !/^\d+\.\d+\.\d+$/.test(tool.latestVersion)) throw new CodexUpdateRefusal('not-outdated', 'A newer release could not be verified for this selected installation. Check again.');
    await requireIdle(runtime, selected.path, installation.binary);
    const confirmed = await resolveCli(spec);
    if (confirmed.path !== selected.path || await realpath(confirmed.path) !== installation.binary) throw new CodexUpdateRefusal('installation-changed', 'The selected installation changed. Check again before updating.');
    receipt = { runtime, status: 'installing', selectedPath: selected.path, manager: installation.manager,
      targetVersion: tool.latestVersion, startedAt: new Date().toISOString() };
    await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
    if (installation.manager === 'npm') {
      const npmCli = await resolveCli({ runtimeId: 'npm', binaryName: 'npm', envOverride: 'O8_NPM_BIN' });
      const npm = await realpath(npmCli.path);
      const metadata = JSON.parse(await readFile(path.join(path.dirname(path.dirname(npm)), 'package.json'), 'utf8'));
      if (npmCli.source === 'env' || !npm.endsWith(path.join('node_modules/npm/bin/npm-cli.js')) || metadata.name !== 'npm') throw new CodexUpdateRefusal('manual-update', 'The original npm toolchain could not be verified. Use its package manager directly.');
      const scope = '@anthropic-ai';
      const packageName = '@anthropic-ai/claude-code';
      await requireUserOwned([installation.root!, path.join(installation.root!, 'lib/node_modules', scope)]);
      const scratch = await mkdtemp(path.join(tmpdir(), 'o8-cli-update-'));
      try {
        const userConfig = path.join(scratch, 'user.npmrc');
        const globalConfig = path.join(scratch, 'global.npmrc');
        await Promise.all([writeFile(userConfig, '', { mode: 0o600 }), writeFile(globalConfig, '', { mode: 0o600 })]);
        await run(process.execPath, [npm, 'install', '--global', '--prefix', installation.root!, '--registry=https://registry.npmjs.org',
          `--${scope}:registry=https://registry.npmjs.org`, `--userconfig=${userConfig}`, `--globalconfig=${globalConfig}`,
          '--ignore-scripts', '--no-audit', '--no-fund', `${packageName}@${tool.latestVersion}`], {
          timeout: 120_000, maxBuffer: 1024 * 1024, cwd: installation.root,
          env: { HOME: process.env.HOME, PATH: `${path.dirname(process.execPath)}${path.delimiter}${path.join(installation.root!, 'bin')}${path.delimiter}/usr/bin${path.delimiter}/bin`, TMPDIR: process.env.TMPDIR, NO_COLOR: '1', NODE_ENV: process.env.NODE_ENV },
        });
      } finally { await rm(scratch, { recursive: true, force: true }); }
    } else if (installation.manager === 'native') {
      await run(selected.path, runtime === 'grok' ? ['--no-auto-update', 'update'] : ['update'], { timeout: 120_000, maxBuffer: 1024 * 1024,
        cwd: path.dirname(selected.path), env: { ...process.env, NO_COLOR: '1' } });
    } else {
      await run(installation.brew!, ['upgrade', installation.packageKind === 'cask' ? '--cask' : '--formula', installation.package!], {
        timeout: 180_000, maxBuffer: 1024 * 1024, cwd: installation.root,
        env: { ...process.env, HOMEBREW_NO_INSTALL_CLEANUP: '1', HOMEBREW_NO_ENV_HINTS: '1' },
      });
    }
    invalidateCliCache(runtime);
    let verified = await resolveCli(spec);
    if (!verified.version && verified.path === selected.path) { invalidateCliCache(runtime); verified = await resolveCli(spec); }
    const after = await inspectCliInstallation(runtime, verified);
    if (verified.path !== selected.path || after.manager !== installation.manager || after.root !== installation.root
      || after.package !== installation.package || !verified.version || compareCliVersions(verified.version, tool.latestVersion) < 0
      || (installation.manager === 'npm' && after.binary !== installation.binary)) {
      throw new CodexUpdateRefusal('verification-failed', 'The command finished, but this selected CLI version could not be verified. Check the installation before retrying.', 503);
    }
    receipt.status = 'succeeded'; receipt.finishedAt = new Date().toISOString();
    await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
    return { status: 'succeeded', installedVersion: verified.version, latestVersion: tool.latestVersion };
  } catch (error) {
    invalidateCliCache(runtime);
    if (receipt) { receipt.status = 'failed'; receipt.finishedAt = new Date().toISOString(); await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600 }); }
    if (error instanceof CodexUpdateRefusal) throw error;
    throw new CodexUpdateRefusal('update-failed', 'This CLI could not be updated. Check the selected installation before retrying.', 503);
  } finally { await lock.close(); await unlink(lockPath); }
}
