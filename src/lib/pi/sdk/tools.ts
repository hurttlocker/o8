import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { openWorkspaceFile, type OpenWorkspaceFileResult } from '@/lib/fs/workspace-file';

export const PI_SDK_TOOLS = [
  { name: 'read_file', description: 'Read a UTF-8 file in the selected workspace.', parameters: {
    type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false,
  } },
  { name: 'write_file', description: 'Write a UTF-8 file after approval of its exact content.', parameters: {
    type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content'], additionalProperties: false,
  } },
] as const;
export interface PiToolCall { name: string; args: Record<string, unknown>; before?: string }
export type PiApproval = (call: PiToolCall, signal: AbortSignal) => Promise<boolean>;
const MAX_BYTES = 50_000;

function protectedPath(path: string) {
  return path.split(/[\\/]/).some(part => part === '..' || part.toLowerCase() === '.git'
    || part.toLowerCase().startsWith('.env'));
}
async function checkPath(root: string, path: string) {
  if (isAbsolute(path) || protectedPath(path)) throw new Error('Invalid workspace path');
  const rel = relative(root, resolve(root, path));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Invalid workspace path');
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
  return { path: parentPath, dev: parent.dev, ino: parent.ino };
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

export async function executePiTool(root: string, call: PiToolCall, approve: PiApproval, signal: AbortSignal) {
  signal.throwIfAborted();
  if (!PI_SDK_TOOLS.some(tool => tool.name === call.name)) throw new Error('Tool is not available');
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
    if (!await approve({ name: call.name, args: structuredClone(args), before: before?.toString('utf8') }, signal)) {
      throw new Error('File write was not approved');
    }
    signal.throwIfAborted();
    const currentParent = await checkPath(root, path);
    if (currentParent.path !== parent.path || currentParent.dev !== parent.dev || currentParent.ino !== parent.ino) {
      throw new Error('Workspace parent changed during approval');
    }
    if (opened) {
      const target = await lstat(opened.lexicalPath);
      const current = await opened.handle.stat();
      if (target.dev !== opened.stat.dev || target.ino !== opened.stat.ino || current.nlink !== 1
        || !before!.equals(await snapshot(root, opened))) throw new Error('File changed during approval');
    } else {
      // Creation happens only after approval. Refuse to overwrite a target that
      // appeared while approval was pending. The descriptor helper validates IO.
      opened = await openWorkspaceFile(root, path, 'read-write', { create: true });
      if (!opened.created) throw new Error('File appeared during approval');
      await snapshot(root, opened);
    }
    signal.throwIfAborted();
    const bytes = Buffer.from(args.content, 'utf8');
    await opened.handle.truncate(0);
    if (bytes.length) await opened.handle.writeFile(bytes);
    await opened.handle.sync();
    return { content: [{ type: 'text' as const, text: `Wrote ${path}` }] };
  } finally { await opened?.handle.close(); }
}
