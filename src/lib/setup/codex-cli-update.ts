import 'server-only';

import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, realpath, readFile, stat, open, unlink, mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { getDataDir } from '@/lib/data-dir-migration';
import { getUpdateIdleWindow } from '@/lib/app-update/idle-window';
import { invalidateCliCache, resolveCli } from '@/lib/runtimes/shared/cli-resolver';
import { checkCliUpdates } from './cli-updates';

const DATA_DIR = getDataDir();
const execFileAsync = promisify(execFile);
const spec = { runtimeId: 'codex', binaryName: 'codex', envOverride: 'O8_CODEX_BIN' };
const MANUAL = 'Update this selected Codex installation with its original package manager, then check again. Automatic updates support user-owned npm global installations on macOS and Linux.';

export class CodexUpdateRefusal extends Error {
  constructor(public code: string, message: string, public status = 409) { super(message); }
}

/** Identify the selected package, never whichever npm happens to be on PATH. */
async function selectedNpmInstall(selectedPath: string, source: string) {
  if (process.platform === 'win32' || source === 'env' || process.env.O8_CODEX_BIN) {
    throw new CodexUpdateRefusal('manual-update', MANUAL);
  }
  try {
    const binary = await realpath(selectedPath);
    const suffix = path.join('lib', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (!binary.endsWith(path.sep + suffix)) throw new Error('Not npm');
    const prefix = binary.slice(0, -(suffix.length + 1));
    const packageRoot = path.join(prefix, 'lib/node_modules/@openai/codex');
    const metadata = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8')) as { name?: string };
    if (metadata.name !== '@openai/codex'
      || await realpath(path.join(prefix, 'bin/codex')) !== binary) throw new Error('Mismatched package');
    const npmCli = await resolveCli({ runtimeId: 'npm', binaryName: 'npm', envOverride: 'O8_NPM_BIN' });
    if (npmCli.source === 'env') throw new Error('Custom npm toolchain');
    const npm = await realpath(npmCli.path);
    const npmSuffix = path.join('node_modules', 'npm', 'bin', 'npm-cli.js');
    if (!npm.endsWith(path.sep + npmSuffix)) throw new Error('Not npm');
    // The server's already-running Node is the execution authority. Packaged
    // apps set O8_NODE_BIN for child discovery; it is not a custom npm command.
    const node = await realpath(process.execPath);
    const uid = process.getuid?.();
    if (uid === undefined || uid === 0) throw new Error('Unknown owner');
    for (const item of [prefix, path.join(prefix, 'bin'), path.join(prefix, 'lib/node_modules'), path.join(prefix, 'lib/node_modules/@openai'), packageRoot]) {
      const info = await stat(item);
      if (info.uid !== uid || !info.isDirectory()) throw new Error('Not user-owned');
      await access(item, constants.W_OK);
    }
    await access(node, constants.X_OK);
    const npmMetadata = JSON.parse(await readFile(path.join(path.dirname(path.dirname(npm)), 'package.json'), 'utf8')) as { name?: string };
    if (npmMetadata.name !== 'npm') throw new Error('Not npm');
    return { prefix, npm, node, binary };
  } catch {
    throw new CodexUpdateRefusal('manual-update', MANUAL);
  }
}

async function requireIdle(selectedPath: string, binary: string) {
  const inventory = await getUpdateIdleWindow();
  const codexCommand = (command: string | null) => Boolean(command && /(?:^|[\s/])codex(?:\s|$)/.test(command));
  const active = inventory.unavailable.length > 0
    || inventory.active.lanes.some((lane) => lane.runtime === 'codex')
    || inventory.active.ownedSessions.some((session) => session.surfaceId.startsWith('codex'))
    || inventory.active.managedRuns.some((run) => codexCommand(run.command))
    || inventory.active.terminalSessions.some((session) => codexCommand(session.commandHint));
  if (active) {
    throw new CodexUpdateRefusal('runtime-busy', 'Wait for running Codex sessions to finish, then press Update again. No sessions were stopped.');
  }
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'comm=,args='], { timeout: 3_000, maxBuffer: 1024 * 1024 });
    const active = stdout.split('\n').some((line) => {
      const command = line.trim().split(/\s+/)[0] ?? '';
      return path.basename(command) === 'codex' || line.includes(selectedPath) || line.includes(binary);
    });
    if (active) throw new Error('active');
  } catch {
    throw new CodexUpdateRefusal('runtime-busy', 'Codex may still be running, or its process inventory is unavailable. Wait for Codex sessions to finish, then press Update again. No sessions were stopped.');
  }
}

/** One bounded, user-triggered operation, with a persisted receipt and crash-safe refusal lock. */
export async function updateSelectedCodex() {
  await mkdir(DATA_DIR, { recursive: true });
  const lockPath = path.join(DATA_DIR, 'codex-cli-update.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); } catch {
    throw new CodexUpdateRefusal('update-in-progress', 'A Codex update is already in progress. Check again after it finishes.');
  }
  const receiptPath = path.join(DATA_DIR, 'codex-cli-update.json');
  let receipt: { status: string; selectedPath: string; targetVersion: string; startedAt: string; finishedAt?: string } | undefined;
  try {
    invalidateCliCache('codex');
    const selected = await resolveCli(spec);
    const tool = (await checkCliUpdates(true, 'codex')).find((item) => item.runtimeId === 'codex');
    if (!tool || tool.status !== 'update-available' || tool.selectedPath !== selected.path
      || !tool.latestVersion || !/^\d+\.\d+\.\d+$/.test(tool.latestVersion)) {
      throw new CodexUpdateRefusal('not-outdated', 'A newer stable Codex release could not be verified for the selected installation. Check again.');
    }
    const install = await selectedNpmInstall(selected.path, selected.source);
    await requireIdle(selected.path, install.binary);
    receipt = { status: 'installing', selectedPath: selected.path, targetVersion: tool.latestVersion, startedAt: new Date().toISOString() };
    await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
    const configDir = await mkdtemp(path.join(tmpdir(), 'o8-codex-npm-'));
    const userConfig = path.join(configDir, 'user.npmrc');
    const globalConfig = path.join(configDir, 'global.npmrc');
    try {
      await Promise.all([writeFile(userConfig, '', { mode: 0o600 }), writeFile(globalConfig, '', { mode: 0o600 })]);
      await execFileAsync(install.node, [install.npm, 'install', '--global', '--prefix', install.prefix,
        '--registry=https://registry.npmjs.org', '--@openai:registry=https://registry.npmjs.org', `--userconfig=${userConfig}`, `--globalconfig=${globalConfig}`,
        '--ignore-scripts', '--no-audit', '--no-fund', `@openai/codex@${tool.latestVersion}`], {
        timeout: 120_000, maxBuffer: 1024 * 1024, cwd: install.prefix,
        env: { HOME: process.env.HOME, PATH: `${path.dirname(install.node)}${path.delimiter}${path.join(install.prefix, 'bin')}${path.delimiter}/usr/bin${path.delimiter}/bin`,
          TMPDIR: process.env.TMPDIR, NO_COLOR: '1', NODE_ENV: process.env.NODE_ENV },
      });
    } finally {
      await rm(configDir, { recursive: true, force: true });
    }
    invalidateCliCache('codex');
    let verified = await resolveCli(spec);
    // A cold executable may miss the first bounded version probe after install.
    // Retry once only while both selected paths still identify the same binary.
    if (!verified.version && verified.path === selected.path
      && await realpath(verified.path) === install.binary) {
      invalidateCliCache('codex');
      verified = await resolveCli(spec);
    }
    if (verified.path !== selected.path || await realpath(verified.path) !== install.binary || verified.version !== tool.latestVersion) {
      throw new CodexUpdateRefusal('verification-failed', 'The update finished, but the selected Codex version could not be verified. Check the selected installation before retrying.', 503);
    }
    receipt.status = 'succeeded'; receipt.finishedAt = new Date().toISOString();
    await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
    return { status: 'succeeded', installedVersion: verified.version, latestVersion: tool.latestVersion };
  } catch (error) {
    invalidateCliCache('codex');
    if (receipt) {
      receipt.status = 'failed'; receipt.finishedAt = new Date().toISOString();
      await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
    }
    if (error instanceof CodexUpdateRefusal) throw error;
    throw new CodexUpdateRefusal('update-failed', 'Codex could not be updated. The installation may be incomplete. Check the selected installation before retrying.', 503);
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}
