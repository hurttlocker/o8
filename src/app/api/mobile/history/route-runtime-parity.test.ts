import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'o8-mobile-history-runtime-'));
const piRoot = join(dataDir, 'owned-pi');
const qwenRoot = join(dataDir, 'owned-qwen');
const claudeRoot = join(dataDir, 'owned-claude-code');
const managedEnv = new Map<string, string | undefined>();

function setManagedEnv(key: string, value: string) {
  managedEnv.set(key, process.env[key]);
  process.env[key] = value;
}

setManagedEnv('CORTEX_IDE_DATA_DIR', dataDir);
setManagedEnv('O8_OWNED_PI_ROOT', piRoot);
setManagedEnv('O8_OWNED_QWEN_ROOT', qwenRoot);
setManagedEnv('CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT', claudeRoot);

const { appendEvent, createLane } = await import('@/lib/lane/registry');
const { getMobileSessionTranscript } = await import('@/lib/mobile/history');
const { getRuntime } = await import('@/lib/runtimes/registry');
const { GET } = await import('./route');

function historyRequest(sessionKey: string, limit = 50) {
  const searchParams = new URLSearchParams({ sessionKey, limit: String(limit) });
  return new NextRequest(`http://localhost:3001/api/mobile/history?${searchParams}`);
}

function writePersistedSession(options: {
  root: string;
  sessionKey: string;
  runOutput: string;
  prompt: string;
}) {
  const sessionId = options.sessionKey.slice(options.sessionKey.indexOf(':') + 1);
  const sessionDir = join(options.root, sessionId);
  const runsDir = join(sessionDir, 'runs');
  const stdoutPath = join(runsDir, 'run.stdout.jsonl');
  const stderrPath = join(runsDir, 'run.stderr.log');
  const timestamp = new Date(Date.now() - 10_000).toISOString();
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(stdoutPath, options.runOutput);
  writeFileSync(stderrPath, '');
  writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({
    surfaceId: options.sessionKey,
    sessionDir,
    cwd: dataDir,
    repoPath: dataDir,
    title: 'Persisted mobile transcript fixture',
    createdAt: timestamp,
    updatedAt: timestamp,
    latestPrompt: options.prompt,
    latestSummary: 'done',
    recentRuns: [{
      id: `run-${sessionId}`,
      mode: 'launch',
      prompt: options.prompt,
      startedAt: timestamp,
      finishedAt: timestamp,
      pid: 1,
      stdoutPath,
      stderrPath,
      outcome: 'finished',
    }],
  }));
  return timestamp;
}

afterAll(() => {
  for (const [key, value] of managedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dataDir, { recursive: true, force: true });
});

describe('mobile history runtime transcript parity', () => {
  it('serves a persisted owned Pi transcript through the mobile history route', async () => {
    const sessionKey = 'pi-owned:mobile-history-pi';
    writePersistedSession({
      root: piRoot,
      sessionKey,
      prompt: 'Check Pi transcript parity',
      runOutput: [
        JSON.stringify({
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'Pi persisted answer' },
        }),
        JSON.stringify({ type: 'agent_end' }),
      ].join('\n'),
    });

    const [response, inboxTranscript] = await Promise.all([
      GET(historyRequest(sessionKey)),
      getMobileSessionTranscript(sessionKey, 50, true),
    ]);
    const payload = await response.json() as {
      transcript: Array<{ id: string; role: string; text: string; timestamp?: number }>;
    };

    expect(response.status).toBe(200);
    expect(payload.transcript).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'run-mobile-history-pi:prompt',
        role: 'user',
        text: 'Check Pi transcript parity',
        timestamp: expect.any(Number),
      }),
      expect.objectContaining({ role: 'assistant', text: 'Pi persisted answer' }),
    ]));
    expect(inboxTranscript).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'run-mobile-history-pi:prompt',
        role: 'user',
        text: 'Check Pi transcript parity',
      }),
    ]));
    expect(payload.transcript.find((entry) => entry.text === 'Pi persisted answer')?.timestamp)
      .toEqual(expect.any(Number));
  });

  it('coalesces persisted owned Claude deltas through history and incremental runtime reads', async () => {
    const sessionKey = 'claude-code-owned:mobile-history-claude';
    const answerId = 'run-mobile-history-claude:message:0:1';
    const answer = 'A `code` span stays whole.\n\n```ts\nconst value = 1;\n```';
    const timestamp = writePersistedSession({
      root: claudeRoot,
      sessionKey,
      prompt: 'Check persisted Claude transcript grouping',
      runOutput: [
        JSON.stringify({ type: 'system', session_id: 'thread-mobile-history-claude' }),
        JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } } }),
        JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Inspecting the stream.' } } }),
        JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'A `co' } } }),
        JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'de` span stays whole.\n\n```ts\ncon' } } }),
        JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'st value = 1;\n```' } } }),
        JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'fixture.ts' } } } }),
        JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'fixture content' }] } }),
      ].join('\n'),
    });

    const runtime = getRuntime('claude-code');
    if (!runtime) throw new Error('Claude Code runtime is not registered.');
    const [response, full] = await Promise.all([
      GET(historyRequest(sessionKey)),
      runtime.readTranscript(sessionKey),
    ]);
    const payload = await response.json() as { transcript: Array<{
      id: string;
      role: string;
      text: string;
      thinking?: string;
      toolCalls?: unknown[];
    }> };

    expect(response.status).toBe(200);
    expect(full.filter((entry) => entry.id === answerId)).toEqual([
      expect.objectContaining({ text: answer }),
    ]);
    expect(payload.transcript.filter((entry) => entry.id === answerId)).toEqual([
      expect.objectContaining({ role: 'assistant', text: answer }),
    ]);
    expect(payload.transcript).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'run-mobile-history-claude:thinking:0:0', thinking: 'Inspecting the stream.' }),
      expect.objectContaining({ text: '', toolCalls: [expect.objectContaining({ name: 'Read', status: 'done' })] }),
    ]));

    const sessionId = sessionKey.slice(sessionKey.indexOf(':') + 1);
    const stdoutPath = join(claudeRoot, sessionId, 'runs', 'run.stdout.jsonl');
    appendFileSync(stdoutPath, '\n' + [
      JSON.stringify({
        type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '\n- next item' } },
      }),
      JSON.stringify({ type: 'result', result: `${answer}\n- next item`, session_id: 'thread-mobile-history-claude' }),
    ].join('\n') + '\n');
    const incremental = await runtime.readTranscript(sessionKey, answerId, 100);
    expect(incremental.filter((entry) => entry.id === answerId)).toEqual([
      expect.objectContaining({ text: `${answer}\n- next item` }),
    ]);
    expect(incremental.filter((entry) => entry.id === answerId)).toHaveLength(1);
    expect(full.find((entry) => entry.id === answerId)?.timestamp.toISOString()).toBe(timestamp);
  });

  it('keeps separate Claude messages when tool rounds reuse content-block index zero', async () => {
    const sessionKey = 'claude-code-owned:mobile-history-claude-rounds';
    writePersistedSession({
      root: claudeRoot,
      sessionKey,
      prompt: 'Check two Claude tool rounds',
      runOutput: [
        JSON.stringify({ type: 'stream_event', event: { type: 'message_start' } }),
        JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'First assistant message.' } } }),
        JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tool-round-1', name: 'Read', input: { file_path: 'first.ts' } } } }),
        JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-round-1', content: 'raw tool output must not render as Markdown' }] } }),
        JSON.stringify({ type: 'stream_event', event: { type: 'message_start' } }),
        JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Second assistant message.' } } }),
        JSON.stringify({ type: 'result', result: 'Second assistant message.' }),
      ].join('\n'),
    });

    const runtime = getRuntime('claude-code');
    if (!runtime) throw new Error('Claude Code runtime is not registered.');
    const entries = await runtime.readTranscript(sessionKey);
    const visible = entries
      .filter((entry) => entry.role !== 'user')
      .map((entry) => ({ id: entry.id, text: entry.text, toolCalls: entry.toolCalls }));

    expect(visible).toEqual([
      expect.objectContaining({ id: 'run-mobile-history-claude-rounds:message:1:0', text: 'First assistant message.' }),
      expect.objectContaining({ text: '', toolCalls: [expect.objectContaining({ id: 'tool-round-1', name: 'Read', status: 'done' })] }),
      expect.objectContaining({ id: 'run-mobile-history-claude-rounds:message:2:0', text: 'Second assistant message.' }),
    ]);
  });

  it('serves a declarative owned runtime and keeps durable operator entries in route and inbox history', async () => {
    const sessionKey = 'qwen-owned:mobile-history-qwen';
    writePersistedSession({
      root: qwenRoot,
      sessionKey,
      prompt: 'Check declarative transcript parity',
      runOutput: [
        JSON.stringify({ type: 'init', session_id: 'thread-mobile-history-qwen' }),
        JSON.stringify({ type: 'message', content: 'Declarative persisted answer' }),
        JSON.stringify({ type: 'result', result: 'done' }),
      ].join('\n'),
    });
    const lane = createLane({
      repoPath: dataDir,
      branch: 'test/mobile-history-qwen',
      runtime: 'qwen',
      sessionKey,
    });
    appendEvent(lane.id, 'steered_packet', 'orchestrator', {
      source: 'orchestrator',
      message: 'Keep the persisted operator direction.',
    });
    appendEvent(lane.id, 'agent_report', 'orchestrator', {
      event: 'huddle',
      message: 'Verify the registered runtime transcript path.',
    });

    const [response, inboxTranscript] = await Promise.all([
      GET(historyRequest(sessionKey)),
      getMobileSessionTranscript(sessionKey, 50, true),
    ]);
    const payload = await response.json() as {
      transcript: Array<{ id: string; role: string; text: string; timestamp?: number }>;
    };
    const routeIds = payload.transcript.map((entry) => entry.id);
    const inboxIds = inboxTranscript.map((entry) => entry.id);

    expect(response.status).toBe(200);
    expect(payload.transcript).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'run-mobile-history-qwen:prompt',
        role: 'user',
        text: 'Check declarative transcript parity',
        timestamp: expect.any(Number),
      }),
    ]));
    expect(payload.transcript.some((entry) => entry.text === 'Declarative persisted answer')).toBe(true);
    expect(routeIds).toEqual(expect.arrayContaining(['steer-1', 'huddle-1']));
    expect(inboxTranscript).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'run-mobile-history-qwen:prompt',
        role: 'user',
        text: 'Check declarative transcript parity',
      }),
    ]));
    expect(inboxTranscript.some((entry) => entry.text === 'Declarative persisted answer')).toBe(true);
    expect(inboxIds).toEqual(expect.arrayContaining(['steer-1', 'huddle-1']));

    const runtime = getRuntime('qwen');
    expect(runtime).toBeDefined();
    const fullTranscript = await runtime!.readTranscript(sessionKey);
    const promptIndex = fullTranscript.findIndex((entry) => entry.id === 'run-mobile-history-qwen:prompt');
    expect(promptIndex).toBeGreaterThanOrEqual(0);
    const delta = await runtime!.readTranscript(sessionKey, fullTranscript[promptIndex]!.id, 2);
    expect(delta).toEqual(fullTranscript.slice(promptIndex + 1).slice(-2));
  });

  it('keeps durable operator entries when a runtime disowns the session', async () => {
    const sessionKey = 'cloud:unknown-mobile-history-job';
    const lane = createLane({
      repoPath: dataDir,
      branch: 'test/mobile-history-unknown-cloud',
      runtime: 'codex',
      sessionKey,
    });
    appendEvent(lane.id, 'steered_packet', 'orchestrator', {
      source: 'orchestrator',
      message: 'Keep this durable direction visible.',
    });

    const transcript = await getMobileSessionTranscript(sessionKey, 50, true);

    expect(transcript).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'user',
        text: expect.stringContaining('Keep this durable direction visible.'),
      }),
    ]));
  });
});
