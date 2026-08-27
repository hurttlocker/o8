import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'o8-mobile-history-runtime-'));
const piRoot = join(dataDir, 'owned-pi');
const qwenRoot = join(dataDir, 'owned-qwen');
const managedEnv = new Map<string, string | undefined>();

function setManagedEnv(key: string, value: string) {
  managedEnv.set(key, process.env[key]);
  process.env[key] = value;
}

setManagedEnv('CORTEX_IDE_DATA_DIR', dataDir);
setManagedEnv('O8_OWNED_PI_ROOT', piRoot);
setManagedEnv('O8_OWNED_QWEN_ROOT', qwenRoot);

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
