import { execFile, type ExecFileOptions } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';

import type { WorktreeMaterializationIdentity } from './materialization-identity';

const materializationContext = new AsyncLocalStorage<ReadonlyMap<string, WorktreeMaterializationIdentity>>();

const WORKSPACE_EXEC_GUARD = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const expected = JSON.parse(process.argv[1]);
let command = process.argv[2];
const args = process.argv.slice(3);
const actual = fs.lstatSync('.');
const canonicalPath = fs.realpathSync('.');
if (!actual.isDirectory() || actual.isSymbolicLink()
  || actual.dev !== expected.device || actual.ino !== expected.inode
  || canonicalPath !== expected.canonicalPath) {
  process.stderr.write('Managed workspace ownership changed before process execution.\n');
  process.exit(78);
}
if (!command.includes(path.sep)) {
  const match = (process.env.PATH || '').split(path.delimiter)
    .map((entry) => path.join(entry, command))
    .find((entry) => { try { fs.accessSync(entry, fs.constants.X_OK); return true; } catch { return false; } });
  if (!match) throw new Error('Managed workspace command could not be resolved.');
  command = match;
}
process.env.PWD = canonicalPath;
process.execve(command, [command, ...args], process.env);
`;

const MATERIALIZATION_REFUSAL_EXIT_CODE = 78;

export function isMaterializationExecutionRefusal(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && Number((error as NodeJS.ErrnoException).code) === MATERIALIZATION_REFUSAL_EXIT_CODE;
}

export function guardedWorkspaceInvocation(
  command: string,
  args: string[],
  identity: WorktreeMaterializationIdentity | null,
): { command: string; args: string[] } {
  if (!identity) return { command, args };
  return {
    command: process.execPath,
    args: ['-e', WORKSPACE_EXEC_GUARD, JSON.stringify(identity), command, ...args],
  };
}

export function withWorktreeMaterializationExecution<T>(
  workspacePath: string,
  identity: WorktreeMaterializationIdentity,
  operation: () => Promise<T>,
): Promise<T> {
  const next = new Map(materializationContext.getStore() ?? []);
  next.set(path.resolve(workspacePath), identity);
  return materializationContext.run(next, operation);
}

/** Execute against the OS-captured cwd, refusing a replacement before exec. */
export function materializationAwareExecFile(
  command: string,
  args: readonly string[],
  options: ExecFileOptions & { cwd?: string | URL } = {},
): Promise<{ stdout: string; stderr: string }> {
  const cwd = typeof options.cwd === 'string' ? path.resolve(options.cwd) : null;
  const identity = cwd ? materializationContext.getStore()?.get(cwd) ?? null : null;
  const invocation = guardedWorkspaceInvocation(command, [...args], identity);
  return new Promise((resolve, reject) => {
    execFile(invocation.command, invocation.args, options, (error, stdout, stderr) => {
      const stdoutText = Buffer.isBuffer(stdout) ? stdout.toString('utf8') : stdout;
      const stderrText = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : stderr;
      if (error) {
        Object.assign(error, { stdout: stdoutText, stderr: stderrText });
        reject(error);
      } else {
        resolve({ stdout: stdoutText, stderr: stderrText });
      }
    });
  });
}
