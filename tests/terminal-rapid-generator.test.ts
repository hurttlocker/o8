import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

type GeneratorResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

function runGenerator(logPath: string): Promise<GeneratorResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      path.join(process.cwd(), 'scripts/bench/terminal-workload/rapid-generator.mjs'),
      '--session', 'test',
      '--duration-ms', '2000',
      '--interval-ms', '40',
      '--log', logPath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('rapid generator did not exit within 10 seconds'));
    }, 10000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

describe('terminal rapid generator', () => {
  it('stays alive through the final sequence and records completion', async () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'o8-rapid-generator-'));
    const logPath = path.join(temporaryDirectory, 'rapid.log');
    try {
      const result = await runGenerator(logPath);
      expect(result).toMatchObject({ code: 0, signal: null, stderr: '' });
      expect(result.stdout).toContain('O8_RAPID_READY_test');
      expect(result.stdout).toContain('O8_RAPID_DONE_test_50');
      const events = fs.readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ event: 'start', sequence: 0 }),
        expect.objectContaining({ event: 'sequence', sequence: 50 }),
        expect.objectContaining({
          event: 'exit',
          code: 0,
          lastSequence: 50,
          stdoutBackpressureCount: 0,
          stdoutDrainCount: 0,
          stdoutErrorCount: 0,
        }),
      ]));
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  }, 15000);
});
