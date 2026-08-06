import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { primeAgentParseRunLog } from '@/lib/prime-agent/owned';
import type { OwnedRunRecord } from '@/lib/runtimes/shared/owned-session/types';
import { parsePrimeAgentSessionCost } from './prime-agent-cost-parser';

let tempDir: string | null = null;

function runRecord(overrides: Partial<OwnedRunRecord> = {}): OwnedRunRecord {
  return {
    id: 'run-1',
    mode: 'launch',
    prompt: 'say hi',
    startedAt: '2026-08-05T12:00:00.000Z',
    finishedAt: '2026-08-05T12:00:05.000Z',
    pid: 123,
    stdoutPath: '/tmp/stdout',
    stderrPath: '/tmp/stderr',
    outcome: 'running',
    ...overrides,
  };
}

async function fixtureFile(name: string, text: string) {
  tempDir ??= await mkdtemp(join(tmpdir(), 'o8-prime-agent-parser-'));
  const filePath = join(tempDir, name);
  await writeFile(filePath, text, 'utf8');
  return filePath;
}

afterEach(async () => {
  if (!tempDir) return;
  await rm(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe('prime-agent runtime parser fixtures', () => {
  it('reads the session id off the first-line session header', () => {
    const parsed = primeAgentParseRunLog(
      '{"type":"session","sessionId":"prime_abc123"}\n'
      + '{"type":"message","role":"assistant","text":"Hi there"}\n',
      runRecord(),
    );

    expect(parsed.threadId).toBe('prime_abc123');
    expect(parsed.entries.some((entry) => entry.text === 'Hi there')).toBe(true);
  });

  it('maps tool_use/tool_result events and a completed result into tail entries', () => {
    const parsed = primeAgentParseRunLog([
      '{"type":"session","sessionId":"prime_123"}',
      '{"type":"message","role":"assistant","text":"Working on it"}',
      '{"type":"tool_use","name":"shell","input":{"command":"pwd"}}',
      '{"type":"tool_result","output":"ok"}',
      '{"type":"result","summary":"done","usage":{"inputTokens":100,"outputTokens":20}}',
    ].join('\n'), runRecord());

    expect(parsed.threadId).toBe('prime_123');
    expect(parsed.completedTurn).toBe(true);
    expect(parsed.outcome).toBe('finished');
    expect(parsed.entries.map((entry) => entry.kind)).toContain('tool');
    expect(parsed.entries.map((entry) => entry.kind)).toContain('tool-output');
    expect(parsed.entries.some((entry) => entry.text.includes('done'))).toBe(true);
  });

  it('surfaces an error event and marks finished-without-result as failed', () => {
    const parsed = primeAgentParseRunLog(
      '{"type":"session","sessionId":"prime_456"}\n{"type":"error","message":"provider auth failed"}\n',
      runRecord(),
    );

    expect(parsed.completedTurn).toBe(false);
    expect(parsed.outcome).toBe('failed');
    expect(parsed.entries.some((entry) => entry.label === 'Error' && entry.text.includes('provider auth failed'))).toBe(true);
  });

  it('parses embedded usage into cost data when present', async () => {
    const filePath = await fixtureFile('prime-agent.jsonl', [
      '{"type":"session","sessionId":"prime_789"}',
      '{"type":"message","text":"working"}',
      '{"type":"result","model":"claude-sonnet-5","usage":{"inputTokens":1000,"outputTokens":200,"cacheWriteTokens":25,"totalCostUsd":0.0123456}}',
    ].join('\n'));

    await expect(parsePrimeAgentSessionCost([filePath])).resolves.toMatchObject({
      inputTokens: 1000,
      outputTokens: 200,
      cacheWriteTokens: 25,
      totalCostUsd: 0.012346,
      model: 'claude-sonnet-5',
    });
  });

  it('returns the conservative empty parse when no usage fields are present', async () => {
    const filePath = await fixtureFile('prime-agent-no-usage.jsonl', [
      '{"type":"session","sessionId":"prime_000"}',
      '{"type":"message","text":"working"}',
      '{"type":"result","summary":"done"}',
    ].join('\n'));

    await expect(parsePrimeAgentSessionCost([filePath])).resolves.toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalCostUsd: 0,
      model: null,
    });
  });
});
