import { execFile as execFileCallback } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { APPROVAL_REPO_ROOT_METADATA_KEY } from '@/lib/approvals/file-edit';
import { createApproval } from '@/lib/approvals/store';

const MAX_FILE_BYTES = 64_000;
const MAX_SHELL_OUTPUT = 12_000;
const SHELL_TIMEOUT_MS = 15_000;

const execFile = promisify(execFileCallback);

export type NativeToolResult = {
  status: 'done' | 'error' | 'blocked';
  output: string;
  response: Record<string, unknown>;
  diff?: {
    before: string;
    after: string;
    path: string;
  };
};

function normalizePathForDisplay(repoRoot: string, resolvedPath: string) {
  return relative(repoRoot, resolvedPath).split('\\').join('/');
}

function resolveProjectPath(repoRoot: string | null, inputPath: string): { resolvedPath: string; relativePath: string } | { error: string } {
  if (!repoRoot) {
    return { error: 'No project directory is scoped to this request.' };
  }

  const filePath = inputPath.trim();
  if (!filePath) {
    return { error: 'file_path is required.' };
  }
  if (filePath.includes('\0')) {
    return { error: 'Invalid file path.' };
  }
  if (filePath.split(/[\\/]/).includes('..')) {
    return { error: 'Path traversal is not allowed.' };
  }

  const resolvedPath = resolve(repoRoot, filePath);
  const relativePath = relative(repoRoot, resolvedPath);
  if (!relativePath || relativePath === '') {
    return { resolvedPath, relativePath: '.' };
  }
  if (relativePath.startsWith('..') || relativePath === '..') {
    return { error: 'Path must stay within the project directory.' };
  }
  return {
    resolvedPath,
    relativePath: normalizePathForDisplay(repoRoot, resolvedPath),
  };
}

function truncateOutput(content: string, maxChars: number) {
  if (content.length <= maxChars) return content;
  return `${content.slice(0, maxChars)}\n\n... (truncated, ${content.length.toLocaleString()} chars total)`;
}

export function extractFilePath(args: Record<string, unknown>) {
  const filePath = args.file_path;
  return typeof filePath === 'string' && filePath.trim() ? filePath.trim() : undefined;
}

function isDisallowedToken(token: string, repoRoot: string | null) {
  if (token.startsWith('~/') || token === '~') return 'Home-directory paths are not allowed.';
  if (token.startsWith('file://')) return 'File URLs are not allowed.';
  if (token.startsWith('/')) {
    if (!repoRoot) return 'Absolute paths are not allowed.';
    const relativePath = relative(repoRoot, resolve(token));
    if (relativePath.startsWith('..') || relativePath === '..') {
      return 'Absolute paths must stay within the project directory.';
    }
  }
  if (token.split('/').includes('..') || token.split('\\').includes('..')) {
    return 'Path traversal is not allowed.';
  }
  return null;
}

function tokenizeShellCommand(command: string): { tokens: string[] } | { error: string } {
  if (!command.trim()) return { error: 'command is required.' };
  if (/[\n\r;&|<>]/.test(command)) {
    return { error: 'Shell chaining, pipes, and redirection are not allowed.' };
  }

  const tokens: string[] = [];
  let current = '';
  let quote: '"' | '\'' | null = null;
  let escapeNext = false;

  for (const char of command) {
    if (escapeNext) {
      current += char;
      escapeNext = false;
      continue;
    }
    if (char === '\\') {
      escapeNext = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === '\'') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (quote) return { error: 'Unterminated quoted string.' };
  if (escapeNext) return { error: 'Trailing escape character in command.' };
  if (current) tokens.push(current);
  return tokens.length > 0 ? { tokens } : { error: 'command is required.' };
}

function validateShellCommand(tokens: string[], repoRoot: string | null): { executable: string; args: string[] } | { error: string } {
  const [command, ...args] = tokens;
  const simpleCommands = new Set(['ls', 'cat', 'grep', 'find', 'wc', 'head', 'tail']);

  if (command === 'git') {
    const subcommand = args[0];
    if (!subcommand || !new Set(['status', 'log', 'diff']).has(subcommand)) {
      return { error: 'Only `git status`, `git log`, and `git diff` are allowed.' };
    }
    for (const token of args.slice(1)) {
      if (token.startsWith('--output') || token === '--no-index' || token === '--ext-diff') {
        return { error: `Disallowed git flag: ${token}` };
      }
      const tokenError = isDisallowedToken(token, repoRoot);
      if (tokenError) return { error: tokenError };
    }
    return { executable: command, args };
  }

  if (!simpleCommands.has(command)) {
    return { error: 'Allowed shell commands: ls, cat, grep, find, git status, git log, git diff, wc, head, tail.' };
  }

  for (const token of args) {
    if (command === 'find' && (
      token === '-exec'
      || token === '-delete'
      || token === '-ok'
      || token.startsWith('-exec')
      || token.startsWith('-fprint')
      || token.startsWith('-fprintf')
      || token.startsWith('-fls')
    )) {
      return { error: `Disallowed find flag: ${token}` };
    }
    if (command === 'grep' && (token === '-f' || token.startsWith('--file') || token.startsWith('--exclude-from'))) {
      return { error: `Disallowed grep flag: ${token}` };
    }
    const tokenError = isDisallowedToken(token, repoRoot);
    if (tokenError) return { error: tokenError };
  }

  return { executable: command, args };
}

async function executeReadFile(argumentsValue: Record<string, unknown>, repoRoot: string | null): Promise<NativeToolResult> {
  const filePath = extractFilePath(argumentsValue);
  if (!filePath) {
    return {
      status: 'error',
      output: 'file_path is required.',
      response: { status: 'error', message: 'file_path is required.' },
    };
  }

  const resolved = resolveProjectPath(repoRoot, filePath);
  if ('error' in resolved) {
    return {
      status: 'error',
      output: resolved.error,
      response: { status: 'error', filePath, message: resolved.error },
    };
  }

  try {
    const stat = await fs.stat(resolved.resolvedPath);
    if (!stat.isFile()) {
      return {
        status: 'error',
        output: `${resolved.relativePath} is not a file.`,
        response: { status: 'error', filePath: resolved.relativePath, message: 'Path is not a file.' },
      };
    }

    const content = await fs.readFile(resolved.resolvedPath, 'utf8');
    const truncated = truncateOutput(content, MAX_FILE_BYTES);
    return {
      status: 'done',
      output: truncated,
      response: {
        status: 'done',
        filePath: resolved.relativePath,
        content: truncated,
        truncated: truncated.length !== content.length,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to read file.';
    return {
      status: 'error',
      output: message,
      response: { status: 'error', filePath: resolved.relativePath, message },
    };
  }
}

async function executeEditFile(
  argumentsValue: Record<string, unknown>,
  repoRoot: string | null,
  model: string,
  tabId: string,
): Promise<NativeToolResult> {
  const filePath = extractFilePath(argumentsValue);
  const oldText = typeof argumentsValue.old_text === 'string' ? argumentsValue.old_text : '';
  const newText = typeof argumentsValue.new_text === 'string' ? argumentsValue.new_text : '';

  if (!filePath || !oldText || typeof argumentsValue.new_text !== 'string') {
    return {
      status: 'error',
      output: 'file_path, old_text, and new_text are required.',
      response: { status: 'error', message: 'file_path, old_text, and new_text are required.' },
    };
  }

  const resolved = resolveProjectPath(repoRoot, filePath);
  if ('error' in resolved) {
    return {
      status: 'error',
      output: resolved.error,
      response: { status: 'error', filePath, message: resolved.error },
    };
  }

  try {
    const original = await fs.readFile(resolved.resolvedPath, 'utf8');
    const occurrences = original.split(oldText).length - 1;
    if (occurrences === 0) {
      return {
        status: 'error',
        output: `Exact old_text was not found in ${resolved.relativePath}.`,
        response: { status: 'error', filePath: resolved.relativePath, message: 'old_text was not found exactly once.' },
      };
    }
    if (occurrences > 1) {
      return {
        status: 'error',
        output: `old_text matched ${occurrences} times in ${resolved.relativePath}; the edit must be unambiguous.`,
        response: { status: 'error', filePath: resolved.relativePath, message: 'old_text must match exactly once.' },
      };
    }

    const diff = {
      before: oldText,
      after: newText,
      path: resolved.relativePath,
    };
    const approval = createApproval({
      source: 'llm-chat',
      runtime: 'chat',
      agent: 'Gemini',
      sessionKey: tabId ? `llm-chat:${tabId}` : 'llm-chat:gemini',
      title: 'Edit file',
      description: `Gemini proposed an edit to ${resolved.relativePath}.`,
      summary: `Proposed edit for ${resolved.relativePath}`,
      toolName: 'edit_file',
      args: argumentsValue,
      diff,
      risk: 'medium',
      metadata: {
        Model: model,
        Path: resolved.relativePath,
        ...(repoRoot ? { [APPROVAL_REPO_ROOT_METADATA_KEY]: resolve(repoRoot) } : {}),
      },
    });

    return {
      status: 'done',
      output: `Created approval ${approval.id} for a proposed edit to ${resolved.relativePath}. The file was not modified.`,
      diff,
      response: {
        status: 'pending_approval',
        approvalId: approval.id,
        filePath: resolved.relativePath,
        diff,
        message: 'The edit was proposed and saved for approval. The file was not modified.',
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to prepare edit.';
    return {
      status: 'error',
      output: message,
      response: { status: 'error', filePath: resolved.relativePath, message },
    };
  }
}

async function executeCreateFile(argumentsValue: Record<string, unknown>, repoRoot: string | null): Promise<NativeToolResult> {
  const filePath = extractFilePath(argumentsValue);
  const content = argumentsValue.content;

  if (!filePath || typeof content !== 'string') {
    return {
      status: 'error',
      output: 'file_path and content are required.',
      response: { status: 'error', message: 'file_path and content are required.' },
    };
  }

  const resolved = resolveProjectPath(repoRoot, filePath);
  if ('error' in resolved) {
    return {
      status: 'error',
      output: resolved.error,
      response: { status: 'error', filePath, message: resolved.error },
    };
  }
  if (resolved.relativePath === '.') {
    return {
      status: 'error',
      output: 'file_path must point to a file within the project directory.',
      response: { status: 'error', filePath, message: 'file_path must point to a file within the project directory.' },
    };
  }

  try {
    await fs.stat(resolved.resolvedPath);
    return {
      status: 'error',
      output: `${resolved.relativePath} already exists. Use edit_file instead.`,
      response: {
        status: 'error',
        filePath: resolved.relativePath,
        message: 'File already exists. Use edit_file instead.',
      },
    };
  } catch (error) {
    const errorCode = typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code)
      : undefined;
    if (errorCode !== 'ENOENT') {
      const message = error instanceof Error ? error.message : 'Unable to create file.';
      return {
        status: 'error',
        output: message,
        response: { status: 'error', filePath: resolved.relativePath, message },
      };
    }
  }

  try {
    await fs.mkdir(dirname(resolved.resolvedPath), { recursive: true });
    await fs.writeFile(resolved.resolvedPath, content, 'utf8');

    const bytes = Buffer.byteLength(content, 'utf8');
    return {
      status: 'done',
      output: `Created ${resolved.relativePath} (${bytes} bytes).`,
      response: {
        status: 'done',
        filePath: resolved.relativePath,
        bytes,
        message: 'File created successfully.',
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to create file.';
    return {
      status: 'error',
      output: message,
      response: { status: 'error', filePath: resolved.relativePath, message },
    };
  }
}

async function executeShell(argumentsValue: Record<string, unknown>, repoRoot: string | null): Promise<NativeToolResult> {
  const command = typeof argumentsValue.command === 'string' ? argumentsValue.command.trim() : '';
  if (!command) {
    return {
      status: 'error',
      output: 'command is required.',
      response: { status: 'error', message: 'command is required.' },
    };
  }
  if (!repoRoot) {
    return {
      status: 'error',
      output: 'No project directory is scoped to this request.',
      response: { status: 'error', message: 'No project directory is scoped to this request.' },
    };
  }

  const tokenized = tokenizeShellCommand(command);
  if ('error' in tokenized) {
    return {
      status: 'blocked',
      output: tokenized.error,
      response: { status: 'blocked', command, message: tokenized.error },
    };
  }

  const validated = validateShellCommand(tokenized.tokens, repoRoot);
  if ('error' in validated) {
    return {
      status: 'blocked',
      output: validated.error,
      response: { status: 'blocked', command, message: validated.error },
    };
  }

  try {
    const { stdout, stderr } = await execFile(validated.executable, validated.args, {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: SHELL_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    const output = truncateOutput([stdout, stderr].filter(Boolean).join('\n').trim() || '(command completed with no output)', MAX_SHELL_OUTPUT);
    return {
      status: 'done',
      output,
      response: { status: 'done', command, output },
    };
  } catch (error) {
    const execError = error as {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      message?: string;
    };
    const output = truncateOutput(
      [execError.stdout, execError.stderr, execError.message].filter(Boolean).join('\n').trim() || 'Command failed.',
      MAX_SHELL_OUTPUT,
    );
    return {
      status: 'error',
      output,
      response: {
        status: 'error',
        command,
        output,
        exitCode: execError.code ?? null,
      },
    };
  }
}

export async function executeNativeTool(
  toolName: string,
  argumentsValue: Record<string, unknown>,
  options: { model: string; repoRoot: string | null; tabId: string },
): Promise<NativeToolResult> {
  if (toolName === 'read_file') {
    return executeReadFile(argumentsValue, options.repoRoot);
  }
  if (toolName === 'create_file') {
    return executeCreateFile(argumentsValue, options.repoRoot);
  }
  if (toolName === 'edit_file') {
    return executeEditFile(argumentsValue, options.repoRoot, options.model, options.tabId);
  }
  if (toolName === 'shell') {
    return executeShell(argumentsValue, options.repoRoot);
  }
  return {
    status: 'error',
    output: `Unknown tool: ${toolName}`,
    response: { status: 'error', message: `Unknown tool: ${toolName}` },
  };
}
