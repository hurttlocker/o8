import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { devNull } from 'node:os';
import path from 'node:path';

import { materializationAwareExecFile } from '@/lib/worktree/materialization-execution';

export class LaneGitMetadataError extends Error {
  constructor() {
    super('Lane Git metadata disagrees with the host repository.');
    this.name = 'LaneGitMetadataError';
  }
}

/** Inherited Git routing, config injection and executable overrides are untrusted. */
export function laneGitEnvironment(ignoreGlobalConfig = false): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith('GIT_')) delete env[key];
  delete env.NODE_OPTIONS;
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0',
    ...(ignoreGlobalConfig ? { GIT_CONFIG_GLOBAL: devNull } : {}) };
}

export function laneGitArguments(args: readonly string[]): string[] {
  const command = args[0];
  return ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${devNull}`,
    '-c', 'commit.gpgSign=false', '-c', 'submodule.recurse=false', '-c', 'core.pager=cat',
    '-c', 'gc.auto=0', '-c', 'maintenance.auto=false',
    ...args.slice(0, 1),
    ...(['diff', 'show', 'log'].includes(command) ? ['--no-ext-diff', '--no-textconv'] : []),
    ...args.slice(1)];
}

export interface LaneGitOptions {
  timeout?: number;
  maxBuffer?: number;
  /** Host-created temporary index, never inherited from the lane. */
  indexFile?: string;
  identity?: { name: string; email: string };
}

function configEntries(cwd: string, env: NodeJS.ProcessEnv, scope: 'effective' | 'system' | 'global', pattern: string): Array<[string, string]> {
  try {
    const output = execFileSync('git', [...laneGitArguments([]), 'config',
      ...(scope === 'effective' ? [] : [`--${scope}`, '--includes']), '--null', '--get-regexp', pattern], {
      cwd, env, encoding: 'utf8', timeout: 5000, maxBuffer: 512 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return output.split('\0').filter(Boolean).map((entry) => {
      const split = entry.indexOf('\n');
      if (split < 0) throw new LaneGitMetadataError();
      return [entry.slice(0, split), entry.slice(split + 1)];
    });
  } catch (error) {
    if ((error as { status?: number }).status === 1) return [];
    throw error;
  }
}

/** Reset executable transport config, then restore only trusted system and global credentials. */
function transportArguments(cwd: string, env: NodeJS.ProcessEnv): string[] {
  const pattern = '^(core\\.(sshcommand|askpass)|credential(\\..*)?\\.helper)$';
  if (configEntries(cwd, env, 'effective', '^remote\\..*\\.vcs$').length) {
    // A vcs value can select a lane-owned git-remote-* executable even for a
    // file URL. There is no command flag that safely clears this setting.
    throw new LaneGitMetadataError();
  }
  // System config (for example a platform keychain helper) is read explicitly,
  // since lane Git runs with GIT_CONFIG_NOSYSTEM; Git applies it before global.
  const trusted = [...configEntries(cwd, env, 'system', pattern), ...configEntries(cwd, env, 'global', pattern)];
  const effective = configEntries(cwd, env, 'effective', pattern);
  const args = ['-c', 'protocol.allow=never', '-c', 'protocol.ext.allow=never', '-c', 'core.sshCommand=ssh', '-c', 'core.askPass=',
    '-c', 'credential.helper='];
  const protocols = new Set(['file', 'git', 'ssh', 'http', 'https']);
  for (const [key] of configEntries(cwd, env, 'effective', '^protocol\\..*\\.allow$')) {
    args.push('-c', `${key}=never`);
  }
  for (const protocol of protocols) args.push('-c', `protocol.${protocol}.allow=always`);
  const keys = new Set([...effective, ...trusted].map(([key]) => key));
  for (const key of keys) {
    if (/^credential\..+\.helper$/.test(key)) args.push('-c', `${key}=`);
  }
  // Empty helper values reset Git's multi-valued list. Re-append the operator's
  // system then global entries in order, including URL-scoped helpers and resets.
  for (const [key, value] of trusted) {
    args.push('-c', `${key}=${value}`);
  }
  return args;
}

function realDirectory(directory: string): string {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new LaneGitMetadataError();
  return realpathSync(directory);
}

function readPointer(file: string, prefix = ''): string {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024) throw new LaneGitMetadataError();
  const value = readFileSync(file, 'utf8').trim();
  if (!value.startsWith(prefix) || !value.slice(prefix.length).trim()) throw new LaneGitMetadataError();
  return realpathSync(path.resolve(path.dirname(file), value.slice(prefix.length).trim()));
}

/** Find linked administration from host backlinks, never from the lane's pointer. */
function resolveGitDirectories(worktreePath: string, repoPath: string, env: NodeJS.ProcessEnv) {
  try {
    const worktree = realDirectory(worktreePath);
    const dotGit = path.join(worktree, '.git');
    const host = realDirectory(repoPath);
    const common = realDirectory(execFileSync('git', laneGitArguments([
      'rev-parse', '--path-format=absolute', '--git-common-dir',
    ]), { cwd: host, env, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim());
    const matches: string[] = [];
    const entries = path.join(common, 'worktrees');
    let names: string[] = [];
    try { names = readdirSync(entries); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    for (const name of names) {
      const admin = path.join(entries, name);
      try {
        if (readPointer(path.join(realDirectory(admin), 'gitdir')) === dotGit) matches.push(admin);
      } catch (error) {
        // A prunable, missing sibling worktree does not invalidate this lane.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    const stat = lstatSync(dotGit);
    if (matches.length) {
      if (matches.length !== 1 || !stat.isFile() || stat.isSymbolicLink()) throw new LaneGitMetadataError();
      const admin = realDirectory(matches[0]);
      if (readPointer(dotGit, 'gitdir:') !== admin || readPointer(path.join(admin, 'commondir')) !== common) {
        throw new LaneGitMetadataError();
      }
      return { worktree, admin, common };
    }
    // Independent CoW clones own a real .git directory below their root.
    const admin = realDirectory(dotGit);
    if (admin !== dotGit || path.relative(worktree, admin) !== '.git') throw new LaneGitMetadataError();
    try {
      lstatSync(path.join(admin, 'commondir'));
      throw new LaneGitMetadataError();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return { worktree, admin, common: admin };
  } catch (error) {
    if (error instanceof LaneGitMetadataError) throw error;
    throw new LaneGitMetadataError();
  }
}

export function laneGitInvocation(worktreePath: string, repoPath: string, args: readonly string[], ignoreGlobalConfig = false, options: LaneGitOptions = {}) {
  const env = laneGitEnvironment(ignoreGlobalConfig);
  const directories = resolveGitDirectories(worktreePath, repoPath, env);
  Object.assign(env, { GIT_DIR: directories.admin, GIT_COMMON_DIR: directories.common,
    GIT_WORK_TREE: directories.worktree });
  if (options.indexFile) env.GIT_INDEX_FILE = options.indexFile;
  if (options.identity) Object.assign(env, {
    GIT_AUTHOR_NAME: options.identity.name, GIT_AUTHOR_EMAIL: options.identity.email,
    GIT_COMMITTER_NAME: options.identity.name, GIT_COMMITTER_EMAIL: options.identity.email,
  });
  const safe = laneGitArguments([]);
  let keys = '';
  try {
    keys = execFileSync('git', [...safe, 'config', '--null', '--name-only', '--get-regexp',
      '^filter\..*\.(clean|smudge|process|required)$'], {
      cwd: directories.worktree, env, encoding: 'utf8', timeout: 5000, maxBuffer: 512 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    if ((error as { status?: number }).status !== 1) throw error;
  }
  const drivers = new Set<string>();
  for (const key of keys.split('\0').filter(Boolean)) {
    const match = /^filter\.(.+)\.(clean|smudge|process|required)$/.exec(key);
    if (!match) throw new LaneGitMetadataError();
    drivers.add(match[1]);
  }
  const filters: string[] = [];
  for (const driver of drivers) {
    for (const field of ['clean', 'smudge', 'process', 'required']) {
      filters.push('-c', `filter.${driver}.${field}=${field === 'required' ? 'false' : ''}`);
    }
  }
  // Revalidate after enumeration. Command-line routing pins these directories,
  // but a concurrently introduced filter driver remains an enumeration race.
  const repeated = resolveGitDirectories(worktreePath, repoPath, laneGitEnvironment(ignoreGlobalConfig));
  if (JSON.stringify(repeated) !== JSON.stringify(directories)) throw new LaneGitMetadataError();
  const isTransport = ['fetch', 'push', 'ls-remote', 'credential'].includes(args[0]);
  const transport = isTransport ? transportArguments(directories.worktree, env) : [];
  if (isTransport) env.GIT_PROXY_COMMAND = '';
  // Remote upload/receive-pack config is first-value wins. Command flags take
  // precedence even when a later -c remote.* override would be ignored.
  const program = ['fetch', 'ls-remote'].includes(args[0]) ? ['--upload-pack=git-upload-pack']
    : args[0] === 'push' ? ['--receive-pack=git-receive-pack'] : [];
  return { args: [...filters, ...transport, ...laneGitArguments(program.length ? [args[0], ...program, ...args.slice(1)] : args)],
    env, cwd: directories.worktree };
}

export function laneGitSync(worktreePath: string, repoPath: string, args: readonly string[], options: ExecFileSyncOptions & LaneGitOptions = {}): string {
  const invocation = laneGitInvocation(worktreePath, repoPath, args, false, options);
  return execFileSync('git', invocation.args, { windowsHide: true, timeout: 15_000,
    maxBuffer: 10 * 1024 * 1024, ...options, ...invocation, encoding: 'utf8' }).toString();
}

export async function laneGit(worktreePath: string, repoPath: string, args: readonly string[],
  options: LaneGitOptions = {}) {
  const invocation = laneGitInvocation(worktreePath, repoPath, args, false, options);
  return materializationAwareExecFile('git', invocation.args, { windowsHide: true, timeout: 15_000,
    maxBuffer: 10 * 1024 * 1024, ...options, cwd: invocation.cwd, env: invocation.env });
}
