import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { buildRuleCheckFailureMessage, runRuleCheck } from './rule-check';

const execFileAsync = promisify(execFile);
const COMMAND_MAX_BUFFER = 10 * 1024 * 1024;
const TYPECHECK_TIMEOUT_MS = 120_000;
const TYPECHECK_OUTPUT_LIMIT = 12_000;

export type CompletionVerificationKind = 'typecheck' | 'rule-check';

export interface CompletionTypecheckResult {
  ok: boolean;
  output: string;
}

export interface CompletionVerificationResult {
  ok: boolean;
  kind: CompletionVerificationKind;
  output: string;
}

export async function runCompletionTypecheck(cwd: string): Promise<CompletionTypecheckResult> {
  try {
    const { stdout, stderr } = await execFileAsync('npx', ['tsc', '--noEmit'], {
      cwd,
      timeout: TYPECHECK_TIMEOUT_MS,
      maxBuffer: COMMAND_MAX_BUFFER,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    });

    return {
      ok: true,
      output: formatCommandOutput(stdout, stderr),
    };
  } catch (error) {
    const execError = error as {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      message?: string;
      status?: number | null;
      signal?: NodeJS.Signals | null;
    };
    const commandOutput = formatCommandOutput(
      bufferToString(execError.stdout),
      bufferToString(execError.stderr),
    );
    const failureSummary = execError.signal
      ? `Process terminated by ${execError.signal}.`
      : typeof execError.status === 'number'
        ? `Exit code ${execError.status}.`
        : execError.message?.trim() || 'Command failed.';

    return {
      ok: false,
      output: limitOutput(
        [failureSummary, commandOutput].filter(Boolean).join('\n\n') || 'Command failed with no output.',
      ),
    };
  }
}

export async function runCompletionVerification(
  cwd: string,
  baseRef = 'main',
): Promise<CompletionVerificationResult> {
  const typecheck = await runCompletionTypecheck(cwd);
  if (!typecheck.ok) {
    return {
      ok: false,
      kind: 'typecheck',
      output: typecheck.output,
    };
  }

  const ruleCheck = await runRuleCheck(cwd, baseRef);
  if (!ruleCheck.ok) {
    return {
      ok: false,
      kind: 'rule-check',
      output: buildRuleCheckFailureMessage(ruleCheck),
    };
  }

  return { ok: true, kind: 'typecheck', output: '' };
}

export function buildVerificationFailureSteerMessage(result: CompletionVerificationResult): string {
  if (result.kind === 'rule-check') {
    return [
      'Post-completion rule check failed. Do not stop here.',
      'These are CLAUDE.md invariants enforced by the supervisor — fix every violation and report completion again.',
      '',
      result.output,
    ].join('\n');
  }
  return buildTypecheckFailureSteerMessage(result.output);
}

export async function autoCommitCompletionWorktree(cwd: string): Promise<boolean> {
  const { stdout: porcelain } = await execFileAsync('git', ['status', '--porcelain'], {
    cwd,
    maxBuffer: COMMAND_MAX_BUFFER,
  });
  if (!porcelain.trim()) {
    return false;
  }

  await execFileAsync(
    'git',
    [
      'add',
      '-A',
      '--',
      '.',
      ':!node_modules',
      ':!.next',
      ':!dist',
      ':!out',
      ':!coverage',
      ':!artifacts',
      ':!.cortex-worktrees',
    ],
    { cwd, maxBuffer: COMMAND_MAX_BUFFER },
  );
  await execFileAsync('git', ['commit', '-m', 'auto-commit: agent work before review'], {
    cwd,
    maxBuffer: COMMAND_MAX_BUFFER,
  });
  return true;
}

export function buildTypecheckFailureSteerMessage(output: string): string {
  return [
    'Post-completion verification failed. Do not stop here.',
    'Fix the TypeScript errors below, rerun `npx tsc --noEmit`, and only report completion after it passes.',
    '',
    'Typecheck output:',
    '```',
    limitOutput(output || 'TypeScript reported a failure with no output.'),
    '```',
  ].join('\n');
}

function formatCommandOutput(stdout: string, stderr: string): string {
  const trimmedStdout = stdout.trim();
  const trimmedStderr = stderr.trim();

  if (trimmedStdout && trimmedStderr) {
    return `${trimmedStdout}\n\nSTDERR:\n${trimmedStderr}`;
  }
  if (trimmedStdout) {
    return trimmedStdout;
  }
  if (trimmedStderr) {
    return `STDERR:\n${trimmedStderr}`;
  }
  return '';
}

function bufferToString(value?: string | Buffer): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Buffer) {
    return value.toString('utf-8');
  }
  return '';
}

function limitOutput(output: string): string {
  const normalized = output.trim();
  if (!normalized) {
    return 'Command failed with no output.';
  }
  if (normalized.length <= TYPECHECK_OUTPUT_LIMIT) {
    return normalized;
  }
  return `${normalized.slice(0, TYPECHECK_OUTPUT_LIMIT)}\n\n... (truncated)`;
}
