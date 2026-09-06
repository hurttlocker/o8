import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

it.skipIf(process.platform !== 'darwin')('captures a setup token through the real PTY entry point without exposing its output', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'o8-token-capture-test-'));
  const binary = path.join(directory, 'fixture-cli');
  const token = `sk-ant-oat01-${'synthetic'.repeat(12)}`;
  writeFileSync(binary, [
    `#!${process.execPath}`,
    'if (process.argv.includes("--version")) { console.log("2.1.261"); process.exit(); }',
    // More redraw data than the old capture ceiling must not abort approval.
    'process.stdout.write("Browser didn\'t open?".repeat(20000));',
    `setTimeout(() => console.log(${JSON.stringify(token)}), 100);`,
  ].join('\n'), { mode: 0o700 });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    O8_DATA_DIR: directory,
    CORTEX_IDE_DATA_DIR: directory,
    O8_MASTER_KEY: Buffer.alloc(32, 7).toString('base64url'),
    O8_CLAUDE_CODE_BIN: binary,
  };
  delete env.O8_WORKER_TOKEN;
  delete env.O8_WORKER_PACKET_ID;
  try {
    const result = await execFileAsync(process.execPath, [
      '--import', './scripts/register-server-only-stub.mjs', '--import', 'tsx', 'scripts/connect-native-worker.ts',
    ], { cwd: process.cwd(), env, timeout: 15_000, maxBuffer: 16 * 1024 });
    expect(result.stdout).toContain('Worker token encrypted and saved.');
    expect(result.stdout + result.stderr).not.toContain(token);
    expect(readFileSync(path.join(directory, 'native-worker-token.json'), 'utf8')).not.toContain(token);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 20_000);
