import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCursorSessionCost } from './cursor-cost-parser';
import { cursorParseRunLog } from '@/lib/cursor/owned';
import type { OwnedRunRecord } from '@/lib/runtimes/shared/owned-session/types';

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
  tempDir ??= await mkdtemp(join(tmpdir(), 'o8-cursor-parser-'));
  const filePath = join(tempDir, name);
  await writeFile(filePath, text, 'utf8');
  return filePath;
}

afterEach(async () => {
  if (!tempDir) return;
  await rm(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe('cursor runtime parser fixtures', () => {
  it('parses a happy stream transcript', () => {
    const parsed = cursorParseRunLog([
      '{"type":"init","session_id":"cur_123"}',
      '{"type":"message","role":"assistant","text":"Hi there"}',
      '{"type":"tool_call","name":"read_file","input":{"path":"README.md"}}',
      '{"type":"tool_result","output":"ok"}',
      '{"type":"result","usage":{"inputTokens":100,"outputTokens":20}}',
    ].join('\n'), runRecord());

    expect(parsed.threadId).toBe('cur_123');
    expect(parsed.completedTurn).toBe(true);
    expect(parsed.outcome).toBe('finished');
    expect(parsed.entries.map((entry) => entry.kind)).toContain('tool');
    expect(parsed.entries.some((entry) => entry.text.includes('Hi there'))).toBe(true);
  });

  it('surfaces an error event and marks finished-without-result as failed', () => {
    const parsed = cursorParseRunLog(
      '{"type":"error","message":"auth failed"}\n',
      runRecord(),
    );

    expect(parsed.completedTurn).toBe(false);
    expect(parsed.outcome).toBe('failed');
    expect(parsed.entries.some((entry) => entry.label === 'Error' && entry.text.includes('auth failed'))).toBe(true);
  });

  it('parses a cost line', async () => {
    const filePath = await fixtureFile('cursor.jsonl', [
      '{"type":"message","text":"working"}',
      '{"type":"result","model":"cursor-fast","usage":{"inputTokens":1000,"outputTokens":200,"cacheReadTokens":50,"totalCostUsd":0.1234567}}',
    ].join('\n'));

    await expect(parseCursorSessionCost([filePath])).resolves.toMatchObject({
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 50,
      totalCostUsd: 0.123457,
      model: 'cursor-fast',
    });
  });
});
