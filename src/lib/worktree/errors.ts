import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const ORIGIN_MISSING_PATTERNS = [
  /'origin' does not appear to be a git repository/i,
  /No such remote/i,
  /could not read from remote repository/i,
];

function bufferToString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Buffer) return value.toString('utf-8');
  return '';
}

export function gitCommandErrorMessage(error: unknown): string {
  const execError = error as { stderr?: unknown; stdout?: unknown; message?: unknown };
  const parts = [
    bufferToString(execError.stderr),
    bufferToString(execError.stdout),
    typeof execError.message === 'string' ? execError.message : '',
    error instanceof Error ? error.message : String(error),
  ].map((part) => part.trim()).filter(Boolean);
  return [...new Set(parts)].join('\n') || 'unknown git error';
}

export async function shouldClassifyFetchAsOriginMissing(
  worktreePath: string,
  fetchErrorMessage: string,
): Promise<boolean> {
  if (!ORIGIN_MISSING_PATTERNS.some((pattern) => pattern.test(fetchErrorMessage))) {
    return false;
  }
  try {
    const { stdout } = await execFileAsync('git', ['-C', worktreePath, 'remote', 'get-url', 'origin'], {
      windowsHide: true,
      timeout: 5_000,
    });
    return !stdout.trim();
  } catch {
    return true;
  }
}

export class WorktreeOriginMissingError extends Error {
  public readonly kind = 'repo_misconfigured';
  public readonly baseBranch: string;
  public readonly worktreePath: string;
  public readonly branch: string;
  public readonly fetchErrorMessage: string;

  constructor(options: {
    baseBranch: string;
    worktreePath: string;
    branch: string;
    fetchErrorMessage: string;
    message?: string;
  }) {
    super(options.message ?? `origin remote is not configured for ${options.worktreePath}.`);
    this.name = 'WorktreeOriginMissingError';
    this.baseBranch = options.baseBranch;
    this.worktreePath = options.worktreePath;
    this.branch = options.branch;
    this.fetchErrorMessage = options.fetchErrorMessage;
  }
}
