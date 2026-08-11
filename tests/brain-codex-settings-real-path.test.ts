import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const testCacheRoot = join(process.cwd(), 'node_modules', '.cache');
mkdirSync(testCacheRoot, { recursive: true });
const dataDir = mkdtempSync(join(testCacheRoot, 'o8-brain-codex-route-'));
const argsPath = join(dataDir, 'codex-args.json');
const scriptPath = join(dataDir, 'fake-codex.mjs');
const binaryPath = process.platform === 'win32'
  ? join(dataDir, 'fake-codex.cmd')
  : join(dataDir, 'fake-codex');

process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_CODEX_BIN = binaryPath;
process.env.O8_TEST_CODEX_ARGS_FILE = argsPath;

beforeAll(() => {
  const fixture = `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
writeFileSync(process.env.O8_TEST_CODEX_ARGS_FILE, JSON.stringify(args));
const outputIndex = args.indexOf('--output-last-message');
if (outputIndex < 0 || !args[outputIndex + 1]) process.exit(2);
writeFileSync(args[outputIndex + 1], 'Configured Brain answer.');
`;
  writeFileSync(scriptPath, fixture, 'utf8');
  if (process.platform === 'win32') {
    writeFileSync(binaryPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`, 'utf8');
  } else {
    writeFileSync(binaryPath, fixture, 'utf8');
    chmodSync(binaryPath, 0o755);
  }
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('Engineering Brain Codex settings real path', () => {
  it('persists the API selection and launches that exact model and effort', async () => {
    const { POST } = await import('@/app/api/panel/operator-defaults/route');
    const response = await POST(new Request('http://127.0.0.1/api/panel/operator-defaults', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subscriptionProfile: 'codex-only',
        brainCodexModel: 'gpt-5.6-terra',
        brainCodexEffort: 'xhigh',
      }),
    }));
    expect(response.status).toBe(200);

    const { callCodex, resetCodexProviderCache } = await import('@/lib/cortex/qa/llm/codex-adapter');
    resetCodexProviderCache();
    await expect(callCodex('Which route is active?')).resolves.toBe('Configured Brain answer.');

    const args = JSON.parse(readFileSync(argsPath, 'utf8')) as string[];
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('gpt-5.6-terra');
    expect(args).toContain('-c');
    expect(args[args.indexOf('-c') + 1]).toBe('model_reasoning_effort=xhigh');
  }, 15_000);
});
