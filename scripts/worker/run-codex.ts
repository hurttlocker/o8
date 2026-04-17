import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { EventStream } from './event-stream';

export interface RunCodexOptions {
  cwd: string;
  runId: string;
  packetPrompt: string;
  modelHint?: string;
  stream: EventStream;
}

export interface RunCodexResult {
  exitCode: number;
  stderrTail: string;
}

const STDERR_TAIL_LIMIT = 4_000;

export async function runCodex(opts: RunCodexOptions): Promise<RunCodexResult> {
  const promptDir = await mkdtemp(path.join(tmpdir(), 'o8-worker-prompt-'));
  const promptPath = path.join(promptDir, 'prompt.txt');
  await writeFile(promptPath, opts.packetPrompt, 'utf-8');

  const codexArgs = [
    'exec',
    '--dangerously-bypass-approvals-and-sandbox',
    '--json',
  ];
  if (opts.modelHint) {
    codexArgs.push('--model', opts.modelHint);
  }
  codexArgs.push('--prompt-file', promptPath);

  const child = spawn('codex', codexArgs, {
    cwd: opts.cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdoutBuffer = '';
  let stderrTail = '';

  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBuffer += chunk.toString('utf-8');
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      void opts.stream.postEvent(opts.runId, 'progress', { text: trimmed });
    }
  });

  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail += chunk.toString('utf-8');
    if (stderrTail.length > STDERR_TAIL_LIMIT) {
      stderrTail = stderrTail.slice(-STDERR_TAIL_LIMIT);
    }
  });

  return new Promise<RunCodexResult>((resolve) => {
    child.on('close', (code) => {
      if (stdoutBuffer.trim()) {
        void opts.stream.postEvent(opts.runId, 'progress', { text: stdoutBuffer.trim() });
      }
      resolve({ exitCode: code ?? -1, stderrTail });
    });
  });
}
