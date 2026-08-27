import { spawn } from 'node:child_process';

import { redactBroadcastText } from '@/lib/broadcast/redaction';
import { forceKillTreeWindows } from '@/lib/runtimes/shared/owned-session/helpers';
import {
  beginAutomationPrecheck,
  getAutomationFire,
  recordAutomationPrecheckResult,
  type AutomationFire,
} from './fire-store';

const OUTPUT_TAIL_BYTES = 8 * 1024;

export interface AutomationPrecheckDecision {
  action: 'continue' | 'skip' | 'error';
  fire: AutomationFire;
  note: string;
}

interface ProcessResult {
  status: 'passed' | 'skipped' | 'error';
  exitCode: number | null;
  stdoutTail: string;
  stderrTail: string;
  errorMessage: string | null;
}

function appendTail(current: string, chunk: Buffer | string): string {
  const bytes = Buffer.from(current + chunk.toString(), 'utf8');
  if (bytes.length <= OUTPUT_TAIL_BYTES) return bytes.toString('utf8');
  return bytes.subarray(-OUTPUT_TAIL_BYTES).toString('utf8').replace(/^\uFFFD+/, '');
}

async function killPrecheckTree(pid: number | undefined): Promise<void> {
  if (!pid) return;
  if (process.platform === 'win32') {
    await forceKillTreeWindows(pid);
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // The process already exited between the timeout and the signal.
    }
  }
}

export async function runBoundedAutomationPrecheck(input: {
  command: string;
  cwd: string;
  timeoutMs: number;
}): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let finished = false;
    let timeout: NodeJS.Timeout | null = null;

    const finish = (result: ProcessResult) => {
      if (finished) return;
      finished = true;
      if (timeout) clearTimeout(timeout);
      resolve({
        ...result,
        stdoutTail: redactBroadcastText(result.stdoutTail),
        stderrTail: redactBroadcastText(result.stderrTail),
        errorMessage: result.errorMessage ? redactBroadcastText(result.errorMessage) : null,
      });
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(input.command, {
        cwd: input.cwd,
        env: process.env,
        shell: true,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish({
        status: 'error',
        exitCode: null,
        stdoutTail: stdout,
        stderrTail: stderr,
        errorMessage: `Precheck spawn failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }

    child.stdout?.on('data', (chunk: Buffer) => { stdout = appendTail(stdout, chunk); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr = appendTail(stderr, chunk); });
    child.on('error', (error) => {
      finish({
        status: 'error',
        exitCode: null,
        stdoutTail: stdout,
        stderrTail: stderr,
        errorMessage: `Precheck spawn failed: ${error.message}`,
      });
    });
    child.on('close', (code, signal) => {
      if (timedOut) {
        finish({
          status: 'error',
          exitCode: code,
          stdoutTail: stdout,
          stderrTail: stderr,
          errorMessage: `Precheck timed out after ${input.timeoutMs}ms.`,
        });
        return;
      }
      if (signal) {
        finish({
          status: 'error',
          exitCode: code,
          stdoutTail: stdout,
          stderrTail: stderr,
          errorMessage: `Precheck exited after signal ${signal}.`,
        });
        return;
      }
      finish({
        status: code === 0 ? 'passed' : 'skipped',
        exitCode: code,
        stdoutTail: stdout,
        stderrTail: stderr,
        errorMessage: null,
      });
    });

    timeout = setTimeout(() => {
      timedOut = true;
      void killPrecheckTree(child.pid);
    }, input.timeoutMs);
    timeout.unref();
  });
}

export async function ensureAutomationPrecheck(
  fire: AutomationFire,
  now: () => number = Date.now,
): Promise<AutomationPrecheckDecision> {
  if (fire.precheckStatus === 'none' || fire.precheckStatus === 'bypassed' || fire.precheckStatus === 'passed') {
    return {
      action: 'continue',
      fire,
      note: fire.precheckStatus === 'bypassed' ? 'Precheck bypassed by the operator.' : 'Precheck passed.',
    };
  }
  if (fire.precheckStatus === 'skipped') {
    return { action: 'skip', fire, note: fire.resultNote ?? 'Precheck skipped the agent launch.' };
  }
  if (fire.precheckStatus === 'error') {
    return { action: 'error', fire, note: fire.precheckErrorMessage ?? 'Precheck failed closed.' };
  }
  if (fire.precheckStatus === 'running') {
    const interrupted = recordAutomationPrecheckResult({
      fireId: fire.id,
      status: 'error',
      exitCode: null,
      stdoutTail: fire.precheckStdoutTail ?? '',
      stderrTail: fire.precheckStderrTail ?? '',
      errorMessage: 'Precheck owner ended before recording a result; refusing to rerun it automatically.',
      nowMs: now(),
    }) ?? fire;
    return { action: 'error', fire: interrupted, note: interrupted.precheckErrorMessage ?? 'Precheck failed closed.' };
  }

  const running = beginAutomationPrecheck(fire.id, now());
  if (!running?.precheckCommand || !running.precheckTimeoutMs) {
    const current = getAutomationFire(fire.id) ?? fire;
    return { action: 'continue', fire: current, note: 'No precheck configured.' };
  }
  const result = await runBoundedAutomationPrecheck({
    command: running.precheckCommand,
    cwd: running.repoPath,
    timeoutMs: running.precheckTimeoutMs,
  });
  const completed = recordAutomationPrecheckResult({
    fireId: running.id,
    status: result.status,
    exitCode: result.exitCode,
    stdoutTail: result.stdoutTail,
    stderrTail: result.stderrTail,
    errorMessage: result.errorMessage,
    nowMs: now(),
  }) ?? running;
  if (result.status === 'passed') {
    return { action: 'continue', fire: completed, note: 'Precheck passed.' };
  }
  if (result.status === 'skipped') {
    return {
      action: 'skip',
      fire: completed,
      note: `Precheck skipped the agent launch with exit code ${result.exitCode ?? 'unknown'}.`,
    };
  }
  return { action: 'error', fire: completed, note: result.errorMessage ?? 'Precheck failed closed.' };
}
