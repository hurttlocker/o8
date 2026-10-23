import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { getDataDir } from '@/lib/data-dir-migration';
import { MANUAL_THINKING_EFFORTS } from '@/lib/orchestrator/thinking-effort';

const root = mkdtempSync(join(getDataDir(), 'cli-chat-effort-'));
const binary = join(root, 'cli-fixture');
const receiptPath = join(root, 'calls.jsonl');
let repoPath: string;
let sequence = 0;
writeFileSync(binary, `#!/usr/bin/env node
const { appendFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
appendFileSync(process.env.O8_CLI_EFFORT_RECEIPT, JSON.stringify(args) + '\\n');
if (args.includes('--version')) { console.log('codex-cli 0.159.2'); process.exit(0); }
if (existsSync(join(process.cwd(), 'reject-sol')) && args.includes('model="gpt-6.1-sol"')) {
  console.log(JSON.stringify({ type: 'turn.failed', error: { message: "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account." } }));
  process.exit(1);
}
console.log(JSON.stringify({ type: 'item.completed', item: { text: 'Fixture answer' } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
`);
chmodSync(binary, 0o700);
vi.stubEnv('O8_CODEX_BIN', binary);
vi.stubEnv('O8_GEMINI_BIN', binary);
vi.stubEnv('O8_OPENCODE_BIN', binary);
vi.stubEnv('O8_CLI_EFFORT_RECEIPT', receiptPath);

const { POST } = await import('@/app/api/v2/proxy/cli/route');

function calls(): string[][] {
  return existsSync(receiptPath)
    ? readFileSync(receiptPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    : [];
}

async function post(overrides: Record<string, unknown> = {}) {
  const response = await POST(new Request('http://localhost/api/v2/proxy/cli', {
    method: 'POST',
    body: JSON.stringify({
      runtime: 'codex', model: 'cli:codex:gpt-6.1-sol', repoPath,
      messages: [{ role: 'user', content: 'Reply once.' }], ...overrides,
    }),
  }));
  return { status: response.status, text: await response.text() };
}

beforeEach(() => {
  repoPath = join(root, `repo-${++sequence}`);
  mkdirSync(repoPath);
  writeFileSync(join(getDataDir(), 'repos.json'), JSON.stringify([{ localPath: repoPath }]));
  rmSync(receiptPath, { force: true });
});

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('CLI chat effort through POST and persisted executable arguments', () => {
  it.each(MANUAL_THINKING_EFFORTS)('passes the supported %s pin unchanged to Codex', async (effort) => {
    const result = await post({ effort });
    expect(result.status).toBe(200);
    expect(result.text).toContain('Fixture answer');
    const launches = calls().filter((args) => args[0] === 'exec');
    expect(launches).toHaveLength(1);
    const args = launches[0];
    const index = args.indexOf(`model_reasoning_effort=${effort}`);
    expect(index).toBeGreaterThan(0);
    expect(args[index - 1]).toBe('-c');
    expect(index).toBeLessThan(args.indexOf('--'));
  });

  it.each([undefined, 'adaptive'])('keeps %s effort on the CLI default', async (effort) => {
    expect((await post({ effort })).status).toBe(200);
    const launches = calls().filter((args) => args[0] === 'exec');
    expect(launches).toHaveLength(1);
    expect(launches[0].some((arg) => arg.startsWith('model_reasoning_effort='))).toBe(false);
  });

  it.each(['turbo', '', 'HIGH', 1, false, null, {}, ['high']].map((effort) => [effort]))(
    'rejects malformed effort %j before invoking a CLI', async (effort) => {
      const result = await post({ effort });
      expect(result.status).toBe(400);
      expect(JSON.parse(result.text)).toMatchObject({ code: 'invalid_effort' });
      expect(calls()).toEqual([]);
    },
  );

  it.each(['gemini', 'opencode'])('rejects a concrete pin on %s before invoking a CLI', async (runtime) => {
    const result = await post({ runtime, effort: 'high' });
    expect(result.status).toBe(400);
    expect(JSON.parse(result.text)).toMatchObject({ code: 'effort_unsupported_runtime' });
    expect(calls()).toEqual([]);
  });

  it.each([
    ['cli:codex:gpt-6-luna', 'ultra', 'effort_coerced'],
    ['cli:codex:unknown-model', 'high', 'effort_model_incompatible'],
  ])('rejects incompatible model %s with effort %s', async (model, effort, code) => {
    const result = await post({ model, effort });
    expect(result.status).toBe(400);
    expect(JSON.parse(result.text)).toMatchObject({ code });
    expect(calls()).toEqual([]);
  });

  it('retains a supported effort pin across the existing model fallback', async () => {
    writeFileSync(join(repoPath, 'reject-sol'), '1');
    const result = await post({ effort: 'high' });
    expect(result.status).toBe(200);
    expect(result.text).toContain('Fixture answer');
    const launches = calls().filter((args) => args[0] === 'exec');
    expect(launches).toHaveLength(2);
    expect(launches[1]).toContain('model="gpt-5.6-sol"');
    expect(launches.every((args) => args.includes('model_reasoning_effort=high'))).toBe(true);
  });
});
