import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { grokLaunchArgs, grokParseRunLog, grokResumeArgs } from '@/lib/grok/owned';
import type { OwnedRunRecord } from '@/lib/runtimes/shared/owned-session/types';
import { parseGrokSessionCost } from './grok-cost-parser';

let tempDir: string | null = null;

function runRecord(overrides: Partial<OwnedRunRecord> = {}): OwnedRunRecord {
  return {
    id: 'run-1',
    mode: 'launch',
    prompt: 'say hi',
    startedAt: '2026-07-09T12:00:00.000Z',
    finishedAt: '2026-07-09T12:00:05.000Z',
    pid: 123,
    stdoutPath: '/tmp/stdout',
    stderrPath: '/tmp/stderr',
    outcome: 'running',
    ...overrides,
  };
}

async function fixtureFile(name: string, text: string) {
  tempDir ??= await mkdtemp(join(tmpdir(), 'o8-grok-parser-'));
  const filePath = join(tempDir, name);
  await writeFile(filePath, text, 'utf8');
  return filePath;
}

afterEach(async () => {
  if (!tempDir) return;
  await rm(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe('grok runtime parser fixtures', () => {
  it('uses the current autonomous launch and resume contract', () => {
    expect(grokLaunchArgs({ prompt: 'first', model: 'grok-4.6' })).toEqual([
      '-p', 'first',
      '--json-schema', expect.any(String),
      '--always-approve',
      '--model', 'grok-4.6',
    ]);
    expect(grokResumeArgs({ threadId: 'session-123', prompt: 'again' })).toEqual([
      '-p', 'again',
      '--resume', 'session-123',
      '--json-schema', expect.any(String),
      '--always-approve',
    ]);
  });

  it('parses the current whole-document result contract', () => {
    const parsed = grokParseRunLog(JSON.stringify({
      text: '{"summary":"CURRENT_GROK_OK","status":"ok"}',
      stopReason: 'end_turn',
      sessionId: 'grok-current-123',
      usage: {
        input_tokens: 44_354,
        cache_read_input_tokens: 128,
        output_tokens: 18,
      },
      total_cost_usd: 0.089078,
      modelUsage: {
        'grok-4.6': { inputTokens: 44_354, outputTokens: 18 },
      },
      structuredOutput: { summary: 'CURRENT_GROK_OK', status: 'ok' },
    }), runRecord());

    expect(parsed.threadId).toBe('grok-current-123');
    expect(parsed.completedTurn).toBe(true);
    expect(parsed.outcome).toBe('finished');
    expect(parsed.entries.some((entry) => entry.text.includes('CURRENT_GROK_OK'))).toBe(true);
    expect(parsed.entries.some((entry) => entry.text.includes('$0.089078'))).toBe(true);
  });

  it('parses a happy stream transcript', () => {
    const parsed = grokParseRunLog([
      '{"type":"init","session_id":"grok_123"}',
      '{"type":"message","role":"assistant","text":"Hi there"}',
      '{"type":"tool_call","name":"shell","input":{"command":"pwd"}}',
      '{"type":"tool_result","output":"ok"}',
      '{"type":"result","summary":"done","usage":{"inputTokens":100,"outputTokens":20}}',
    ].join('\n'), runRecord());

    expect(parsed.threadId).toBe('grok_123');
    expect(parsed.completedTurn).toBe(true);
    expect(parsed.outcome).toBe('finished');
    expect(parsed.entries.map((entry) => entry.kind)).toContain('tool');
    expect(parsed.entries.some((entry) => entry.text.includes('done'))).toBe(true);
  });

  it('surfaces an error event and marks finished-without-result as failed', () => {
    const parsed = grokParseRunLog(
      '{"type":"error","message":"schema validation failed"}\n',
      runRecord(),
    );

    expect(parsed.completedTurn).toBe(false);
    expect(parsed.outcome).toBe('failed');
    expect(parsed.entries.some((entry) => entry.label === 'Error' && entry.text.includes('schema validation failed'))).toBe(true);
  });

  it('parses a cost line', async () => {
    const filePath = await fixtureFile('grok.jsonl', [
      '{"type":"message","text":"working"}',
      '{"type":"result","model":"grok-build","usage":{"inputTokens":1000,"outputTokens":200,"cacheWriteTokens":25,"totalCostUsd":0.0123456}}',
    ].join('\n'));

    await expect(parseGrokSessionCost([filePath])).resolves.toMatchObject({
      inputTokens: 1000,
      outputTokens: 200,
      cacheWriteTokens: 25,
      totalCostUsd: 0.012346,
      model: 'grok-build',
    });
  });

  it('uses embedded current-runtime cost and model identity without guessing API billing', async () => {
    const filePath = await fixtureFile('grok-current.json', JSON.stringify({
      stopReason: 'end_turn',
      sessionId: 'grok-current-123',
      usage: {
        input_tokens: 44_354,
        cache_read_input_tokens: 128,
        cache_creation_input_tokens: 7,
        output_tokens: 18,
      },
      total_cost_usd: 0.089078,
      modelUsage: {
        'grok-4.6': { inputTokens: 44_354, outputTokens: 18 },
      },
    }));

    await expect(parseGrokSessionCost([filePath])).resolves.toEqual({
      inputTokens: 44_354,
      outputTokens: 18,
      cacheReadTokens: 128,
      cacheWriteTokens: 7,
      totalCostUsd: 0.089078,
      model: 'grok-4.6',
    });
  });

  it('does not apply API pricing when the CLI omits a charge', async () => {
    const filePath = await fixtureFile('grok-subscription.json', JSON.stringify({
      usage: { input_tokens: 1_000, output_tokens: 200 },
    }));

    await expect(parseGrokSessionCost([filePath])).resolves.toMatchObject({
      inputTokens: 1_000,
      outputTokens: 200,
      totalCostUsd: 0,
      model: null,
    });
  });
});
