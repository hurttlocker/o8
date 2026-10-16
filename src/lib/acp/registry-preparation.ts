import 'server-only';
import { access, constants, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDataDir } from '@/lib/data-dir-migration';
import { executableSuffixes, scanForBinary } from '@/lib/runtimes/shared/cli-locate';
import { cliInvocation } from '@/lib/runtimes/shared/cli-spawn';
import { readAcpRegistry, type AcpRegistryCatalog } from './registry';
import type { LocalAcpConnection } from './local-connection';
import { AcpPreparationHeld, runRegistryInstaller } from './preparation-process';

const pending = new Map<string, Promise<LocalAcpConnection>>();
export function registryPreparationEnvironment(stage: string): NodeJS.ProcessEnv {
  return { NODE_ENV: 'production', PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, LANG: process.env.LANG,
    HOME: path.join(stage, 'home'), XDG_CONFIG_HOME: path.join(stage, 'config'), XDG_CACHE_HOME: path.join(stage, 'cache'),
    TMPDIR: path.join(stage, 'tmp'), TEMP: path.join(stage, 'tmp'), TMP: path.join(stage, 'tmp'),
    BROWSER: 'none', NODE_OPTIONS: '', CI: '1', NO_COLOR: '1',
    NPM_CONFIG_CACHE: path.join(stage, 'cache'), NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org', NPM_CONFIG_IGNORE_SCRIPTS: 'true',
    GIT_CONFIG_GLOBAL: path.join(stage, 'empty.npmrc'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '', GIT_ALLOW_PROTOCOL: 'https', GIT_TERMINAL_PROMPT: '0' };
}

async function npmBinary(): Promise<string> {
  const directories = [path.dirname(process.execPath), ...(process.env.PATH ?? '').split(path.delimiter).filter(path.isAbsolute)];
  for (const directory of directories) for (const suffix of executableSuffixes()) {
    const candidate = path.join(directory, `npm${suffix}`);
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* Filesystem-only discovery never executes a probe. */ }
  }
  const found = scanForBinary('npm'); if (found) return found;
  throw new Error('Install Node.js before preparing this agent.');
}

/** Explicit preparation installs a pinned package into o8 state; it never starts the agent. */
export async function prepareRegistryAgent(input: { id: string; fingerprint: string }, dependencies: {
  read?: () => Promise<AcpRegistryCatalog>;
  root?: string;
  npmBinary?: string;
  supervisor?: string;
  timeoutMs?: number;
} = {}): Promise<LocalAcpConnection> {
  const catalog = await (dependencies.read ?? (() => readAcpRegistry(true)))();
  const agent = catalog.agents.find(agent => agent.id === input.id && agent.fingerprint === input.fingerprint);
  if (catalog.stale || !agent) throw new Error('The registry changed or is offline. Refresh it before preparing this agent.');
  if (!agent.npm) throw new Error('This agent needs manual installation. Use its setup guide, then connect its local executable.');
  const requestedRoot = dependencies.root ?? path.join(getDataDir(), 'acp-agents');
  await mkdir(requestedRoot, { recursive: true });
  const root = await realpath(requestedRoot);
  const key = path.join(root, agent.id, agent.fingerprint);
  const existing = pending.get(key); if (existing) return existing;
  const preparation = (async () => {
    await mkdir(root, { recursive: true });
    const connectionFrom = async (prefix: string): Promise<LocalAcpConnection> => {
      const packageName = agent.npm!.package.slice(0, agent.npm!.package.lastIndexOf('@'));
      const packageVersion = agent.npm!.package.slice(agent.npm!.package.lastIndexOf('@') + 1);
      const packageRoot = path.join(prefix, 'node_modules', packageName);
      const canonicalPrefix = await realpath(prefix);
      if (canonicalPrefix !== prefix || !canonicalPrefix.startsWith(`${root}${path.sep}`)) throw new Error('The prepared agent directory was redirected.');
      const canonicalPackage = await realpath(packageRoot);
      if (!canonicalPackage.startsWith(`${canonicalPrefix}${path.sep}node_modules${path.sep}`)) throw new Error('The prepared package directory was redirected.');
      const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8')) as { name?: string; version?: string; bin?: string | Record<string, string> };
      if (manifest.name !== packageName || manifest.version !== packageVersion) throw new Error('The prepared package does not match the selected version.');
      const bins = typeof manifest.bin === 'string' ? [manifest.bin] : manifest.bin && typeof manifest.bin === 'object' ? Object.values(manifest.bin) : [];
      const choices = [...new Set(bins)];
      if (choices.length !== 1 || typeof choices[0] !== 'string') throw new Error('This package has multiple launchers. Connect its installed executable manually.');
      const bin = await realpath(path.resolve(packageRoot, choices[0]));
      if (!bin.startsWith(`${canonicalPackage}${path.sep}`)) throw new Error('The package launcher is outside its directory.');
      const header = (await readFile(bin, 'utf8')).slice(0, 160);
      if (!/^#![^\n]*\bnode\b/.test(header)) throw new Error('This package needs a native launcher. Connect its installed executable manually.');
      return { name: agent.name.trim().slice(0, 80), command: process.execPath, args: [bin, ...agent.npm!.args], useOpenRouter: false };
    };
    const cachedConnection = async (): Promise<LocalAcpConnection> => {
      if (await realpath(key) !== key) throw new Error('The prepared agent directory was redirected.');
      const receipt = JSON.parse(await readFile(path.join(key, 'o8-prepared.json'), 'utf8'));
      if (receipt.id !== agent.id || receipt.fingerprint !== agent.fingerprint) throw new Error('The saved preparation does not match this agent.');
      return await connectionFrom(key);
    };
    let cached = false;
    try { await lstat(key); cached = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (cached) return await cachedConnection();
    const stage = path.join(root, `.prepare-${randomUUID()}`);
    await mkdir(stage, { mode: 0o700 });
    let held = false;
    try {
    for (const directory of ['home', 'config', 'cache', 'tmp']) await mkdir(path.join(stage, directory));
    for (const file of ['empty.npmrc', 'global.npmrc']) await writeFile(path.join(stage, file), '', { mode: 0o600 });
    const npm = dependencies.npmBinary ?? await npmBinary();
    const invocation = cliInvocation(npm, ['install', '--prefix', stage, '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact',
      '--userconfig', path.join(stage, 'empty.npmrc'), '--globalconfig', path.join(stage, 'global.npmrc'), agent.npm!.package]);
    await runRegistryInstaller(invocation.command, invocation.args, { cwd: stage, env: registryPreparationEnvironment(stage), timeoutMs: dependencies.timeoutMs, supervisor: dependencies.supervisor });
    await connectionFrom(stage);
    await mkdir(path.dirname(key), { recursive: true });
    if (await realpath(path.dirname(key)) !== path.dirname(key)) throw new Error('The prepared agent directory was redirected.');
    // Concurrent preparations coalesce above. A finished version is never replaced.
    await writeFile(path.join(stage, 'o8-prepared.json'), JSON.stringify({ id: agent.id, fingerprint: agent.fingerprint, preparedAt: new Date().toISOString() }), { mode: 0o600 });
    try { await rename(stage, key); } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      await rm(stage, { recursive: true, force: true });
    }
    const connection = await cachedConnection();
    return connection;
    } catch (error) { held = error instanceof AcpPreparationHeld; throw error; }
    finally { if (!held) await rm(stage, { recursive: true, force: true }); }
  })();
  pending.set(key, preparation);
  try { const result = await preparation; pending.delete(key); return result; }
  catch (error) { if (!(error instanceof AcpPreparationHeld)) pending.delete(key); throw error; }
}
