import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { openWorkspaceFile, type OpenWorkspaceFileResult } from '@/lib/fs/workspace-file';
import { commitPiWrite } from './approved-write';
import { PI_COMMAND_MAX_BYTES, piCommandCleanupUnconfirmed, runPiCommand, withPiExclusive, type PiCommandOptions } from './command';
import { ConfinementUnavailable } from '@/lib/sandbox/confine';

export const PI_SDK_TOOLS = [
  { name: 'read_file', description: 'Read a UTF-8 file in the selected workspace.', parameters: {
    type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false,
  } },
  { name: 'write_file', description: 'Write a UTF-8 file after approval of its exact content.', parameters: {
    type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content'], additionalProperties: false,
  } },
  { name: 'run_command', description: 'Run a shell command at the workspace root after approval. It has a time limit, an output limit and no credentials in its environment.', parameters: {
    type: 'object', properties: { command: { type: 'string' } }, required: ['command'], additionalProperties: false,
  } },
] as const;
export interface PiToolCall {
  name: string; args: Record<string, unknown>; before?: string;
  /** Set by the host from the approval policy for commands. */
  risk?: 'low' | 'medium' | 'high'; policyRuleId?: string;
}
export type PiApproval = (call: PiToolCall, signal: AbortSignal) => Promise<boolean>;
/** A host check run inside the host-wide lock immediately before a write commits or a command starts. */
export type PiAuthority = (call: PiToolCall) => Promise<boolean>;
export interface PiToolOptions extends PiCommandOptions {
  /** When set, a false result refuses the call, whatever approval or policy said. Host-set only. */
  authorize?: PiAuthority;
  /**
   * Lane rules (#3385): every command runs confined, with no network and writes
   * only in the workspace and a private temp dir. Where confinement is
   * unavailable the command needs `inbox` approval and then runs unconfined, as
   * approved. Host-set only.
   */
  confine?: { inbox: PiApproval };
}
const MAX_BYTES = 50_000;

function protectedPath(path: string) {
  return path.split(/[\\/]/).some(part => part === '..' || part.toLowerCase() === '.git'
    || part.toLowerCase().startsWith('.env'));
}
async function checkPath(root: string, path: string) {
  if (isAbsolute(path) || protectedPath(path)) throw new Error('Invalid workspace path');
  const rel = relative(root, resolve(root, path));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Invalid workspace path');
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || await realpath(root) !== root) throw new Error('Invalid workspace root');
  // Narrow prototype policy: even in-root symlink aliases are refused.
  let current = root;
  for (const part of rel.split(/[\\/]/)) {
    current = resolve(current, part);
    const stat = await lstat(current).catch(error => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (stat?.isSymbolicLink()) throw new Error('Symlink paths are not available');
  }
  const parentPath = await realpath(dirname(resolve(root, path)));
  const parentRelative = relative(root, parentPath);
  if (parentRelative.startsWith('..') || isAbsolute(parentRelative) || protectedPath(parentRelative)) {
    throw new Error('Invalid workspace parent');
  }
  const parent = await lstat(parentPath);
  return { path: parentPath, dev: parent.dev, ino: parent.ino, root: { dev: rootStat.dev, ino: rootStat.ino } };
}
async function snapshot(root: string, opened: OpenWorkspaceFileResult) {
  if (protectedPath(relative(root, opened.realPath)) || opened.stat.nlink !== 1) {
    throw new Error('Protected or multiply-linked file is not available');
  }
  if ((await opened.handle.stat()).size > MAX_BYTES) throw new Error('File exceeds prototype size limit');
  const buffer = Buffer.alloc(MAX_BYTES + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await opened.handle.read(buffer, offset, buffer.length - offset, offset);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  if (offset > MAX_BYTES) throw new Error('File exceeds prototype size limit');
  return buffer.subarray(0, offset);
}

async function requireAuthority(call: PiToolCall, authorize: PiAuthority | undefined) {
  if (authorize && !await authorize({ name: call.name, args: structuredClone(call.args) })) {
    throw new Error('The workspace no longer allows this call');
  }
}

async function executePiCommand(root: string, call: PiToolCall, approve: PiApproval, signal: AbortSignal,
  { authorize, confine, ...options }: PiToolOptions) {
  const args = structuredClone(call.args);
  const command = args.command;
  if (typeof command !== 'string' || !command.trim() || command.includes('\0')
    || Buffer.byteLength(command) > PI_COMMAND_MAX_BYTES || Object.keys(args).some(key => key !== 'command')) {
    throw new Error('Invalid command arguments');
  }
  // The same policy rules as every other runtime's shell tool: blocked commands
  // never start, and an operator rule can lift approval for a workspace.
  const { evaluatePolicy } = await import('@/lib/approvals/policies');
  const policy = evaluatePolicy({ toolName: 'run_command', command, workspacePath: root, runtime: 'pi' });
  if (policy.blocked) throw new Error('Command is blocked by policy');
  if (policy.requiresApproval && !await approve({ name: call.name, args: structuredClone(args),
    risk: policy.risk, policyRuleId: policy.ruleId }, signal)) {
    throw new Error('Command was not approved');
  }
  // The launcher checks the physical working directory at spawn time.
  const run = (confined: boolean) => withPiExclusive(async () => {
    await requireAuthority(call, authorize);
    return runPiCommand(root, command, signal, { ...options, confined });
  }, signal);
  let text: string;
  try {
    text = await run(Boolean(confine));
  } catch (error) {
    if (!confine || !(error instanceof ConfinementUnavailable)) throw error;
    // Nothing started. Lane rules cover only a confined command, so the operator approves this one.
    if (!await confine.inbox({ name: call.name, args: structuredClone(args), risk: policy.risk,
      policyRuleId: policy.ruleId }, signal)) throw new Error('Command was not approved');
    text = await run(false);
  }
  return { content: [{ type: 'text' as const, text }] };
}

export async function executePiTool(root: string, call: PiToolCall, approve: PiApproval, signal: AbortSignal,
  options: PiToolOptions = {}) {
  signal.throwIfAborted();
  if (!PI_SDK_TOOLS.some(tool => tool.name === call.name)) throw new Error('Tool is not available');
  if (call.name === 'run_command') return executePiCommand(root, call, approve, signal, options);
  const args = structuredClone(call.args);
  const path = args.path;
  if (typeof path !== 'string' || !path
    || Object.keys(args).some(key => !['path', ...(call.name === 'write_file' ? ['content'] : [])].includes(key))) {
    throw new Error('Invalid workspace file arguments');
  }
  const parent = await checkPath(root, path);
  let opened: OpenWorkspaceFileResult | null = null;
  try {
    opened = await openWorkspaceFile(root, path, call.name === 'read_file' ? 'read' : 'read-write').catch(error => {
      if (call.name === 'write_file' && error?.code === 'workspace_file_not_found') return null;
      throw error;
    });
    const before = opened ? await snapshot(root, opened) : null;
    if (call.name === 'read_file') {
      signal.throwIfAborted();
      return { content: [{ type: 'text' as const, text: before!.toString('utf8') }] };
    }
    if (typeof args.content !== 'string' || Buffer.byteLength(args.content) > MAX_BYTES) {
      throw new Error('Invalid file content or prototype size limit exceeded');
    }
    const content = args.content;
    if (!await approve({ name: call.name, args: structuredClone(args), before: before?.toString('utf8') }, signal)) {
      throw new Error('File write was not approved');
    }
    // Checks and commit run under the host-wide lock, so no command from any
    // session is running between the final checks and the commit.
    return await withPiExclusive(async () => {
      signal.throwIfAborted();
      if (piCommandCleanupUnconfirmed()) throw new Error('Earlier command processes could not be confirmed stopped. Restart o8 before writing.');
      const currentParent = await checkPath(root, path);
      if (currentParent.path !== parent.path || currentParent.dev !== parent.dev || currentParent.ino !== parent.ino
        || currentParent.root.dev !== parent.root.dev || currentParent.root.ino !== parent.root.ino) {
        throw new Error('Workspace parent changed during approval');
      }
      if (opened) {
        const target = await lstat(opened.lexicalPath);
        const current = await opened.handle.stat();
        if (target.dev !== opened.stat.dev || target.ino !== opened.stat.ino || current.nlink !== 1
          || !before!.equals(await snapshot(root, opened))) throw new Error('File changed during approval');
      }
      await requireAuthority(call, options.authorize);
      signal.throwIfAborted();
      await commitPiWrite(root, path, parent, opened, before, content, signal);
      return { content: [{ type: 'text' as const, text: `Wrote ${path}` }] };
    }, signal);
  } finally { await opened?.handle.close(); }
}
