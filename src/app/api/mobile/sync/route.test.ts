import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'o8-mobile-sync-runtime-'));
const ownedRoot = join(dataDir, 'owned-opencode');
const ownedCodexRoot = join(dataDir, 'owned-codex');
const nativeCodexRoot = join(dataDir, 'native-codex');
const previousCodexHome = process.env.CODEX_HOME;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_OWNED_OPENCODE_ROOT = ownedRoot;
process.env.CORTEX_IDE_OWNED_CODEX_ROOT = ownedCodexRoot;
process.env.CODEX_HOME = nativeCodexRoot;

const { writePersistedLlmChat } = await import('@/lib/llm/chat-history-store');
const { appendEvent, createLane } = await import('@/lib/lane/registry');
const { GET: getMobileHistory } = await import('../history/route');
const { POST } = await import('./route');

function syncRequest(history: { sessionKey: string; sinceId?: string; limit?: number }) {
  return new NextRequest('http://localhost:3001/api/mobile/sync', {
    method: 'POST',
    body: JSON.stringify({ history }),
    headers: { 'Content-Type': 'application/json' },
  });
}

function historyRequest(sessionKey: string, limit = 200) {
  const searchParams = new URLSearchParams({ sessionKey, limit: String(limit) });
  return new NextRequest(`http://localhost:3001/api/mobile/history?${searchParams}`);
}

afterAll(() => {
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('mobile sync transcript authority', () => {
  it('keeps runtime, steer, and huddle entries authoritative across snapshots and deltas', async () => {
    const sessionKey = 'opencode-owned:sync-durable-fixture';
    const sessionDir = join(ownedRoot, 'sync-durable-fixture');
    const runsDir = join(sessionDir, 'runs');
    const stdoutPath = join(runsDir, 'run.stdout.jsonl');
    const stderrPath = join(runsDir, 'run.stderr.log');
    const runtimeTimestamp = new Date(Date.now() - 10_000).toISOString();
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(stdoutPath, `${JSON.stringify({
      type: 'text',
      part: { text: 'Initial runtime answer' },
      timestamp: runtimeTimestamp,
    })}\n`);
    writeFileSync(stderrPath, '');
    writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({
      surfaceId: sessionKey,
      sessionDir,
      cwd: dataDir,
      repoPath: dataDir,
      title: 'Durable transcript fixture',
      createdAt: runtimeTimestamp,
      updatedAt: runtimeTimestamp,
      latestPrompt: 'test durable sync',
      latestSummary: 'done',
      recentRuns: [{
        id: 'run-durable-fixture',
        mode: 'launch',
        prompt: 'test durable sync',
        startedAt: runtimeTimestamp,
        finishedAt: runtimeTimestamp,
        pid: 1,
        stdoutPath,
        stderrPath,
        outcome: 'finished',
      }],
    }));
    const lane = createLane({
      repoPath: dataDir,
      branch: 'test/durable-transcript',
      runtime: 'opencode',
      sessionKey,
    });
    appendEvent(lane.id, 'steered_packet', 'orchestrator', {
      source: 'orchestrator',
      message: 'Keep the durable operator direction.',
    });
    appendEvent(lane.id, 'agent_report', 'orchestrator', {
      event: 'huddle',
      message: 'Inspect the shared resolver, then verify reconnect behavior.',
    });

    const [historyResponse, snapshotResponse] = await Promise.all([
      getMobileHistory(historyRequest(sessionKey)),
      POST(syncRequest({ sessionKey, limit: 200 })),
    ]);
    const historyPayload = await historyResponse.json() as {
      transcript: Array<{ id: string; role: string; text: string }>;
    };
    const snapshotPayload = await snapshotResponse.json() as {
      history: { entries: Array<{ id: string; role: string; text: string }>; replace?: boolean };
    };
    const snapshotEntries = snapshotPayload.history.entries;
    const snapshotIds = snapshotEntries.map((entry) => entry.id);

    expect(historyResponse.status).toBe(200);
    expect(snapshotResponse.status).toBe(200);
    expect(snapshotPayload.history.replace).not.toBe(true);
    expect(snapshotEntries).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', text: 'test durable sync' }),
    ]));
    expect(snapshotEntries.some((entry) => entry.text === 'Initial runtime answer')).toBe(true);
    expect(snapshotIds).toEqual(expect.arrayContaining(['steer-1', 'huddle-1']));
    expect(new Set(snapshotIds).size).toBe(snapshotIds.length);
    expect(historyPayload.transcript).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', text: 'test durable sync' }),
    ]));
    expect(historyPayload.transcript.some((entry) => entry.text === 'Initial runtime answer')).toBe(true);
    expect(historyPayload.transcript
      .map((entry) => entry.id)
      .filter((id) => id.startsWith('steer-') || id.startsWith('huddle-'))).toEqual(
      snapshotIds.filter((id) => id.startsWith('steer-') || id.startsWith('huddle-')),
    );

    const bootstrapCursor = snapshotIds.at(-1)!;
    await new Promise((resolve) => setTimeout(resolve, 5));
    appendEvent(lane.id, 'agent_report', 'orchestrator', {
      event: 'huddle',
      message: 'The incremental huddle update is durable.',
    });
    const huddleDeltaResponse = await POST(syncRequest({
      sessionKey,
      sinceId: bootstrapCursor,
      limit: 200,
    }));
    const huddleDelta = await huddleDeltaResponse.json() as {
      history: { entries: Array<{ id: string; text: string }>; replace?: boolean };
    };
    expect(huddleDelta.history).toEqual({
      sessionKey,
      entries: [expect.objectContaining({
        id: 'huddle-2',
        text: expect.stringContaining('incremental huddle update'),
      })],
    });

    const huddleCursor = huddleDelta.history.entries.at(-1)!.id;
    appendFileSync(stdoutPath, `${JSON.stringify({
      type: 'text',
      part: { text: 'Runtime answer after the huddle' },
      timestamp: new Date(Date.now() + 5).toISOString(),
    })}\n`);
    const runtimeDeltaResponse = await POST(syncRequest({
      sessionKey,
      sinceId: huddleCursor,
      limit: 200,
    }));
    const runtimeDelta = await runtimeDeltaResponse.json() as {
      history: { entries: Array<{ id: string; text: string }>; replace?: boolean };
    };
    expect(runtimeDelta.history.replace).not.toBe(true);
    expect(runtimeDelta.history.entries).toEqual([
      expect.objectContaining({ text: 'Runtime answer after the huddle' }),
    ]);
  });

  it('reads a persisted OpenCode-owned transcript through the registered runtime', async () => {
    const sessionKey = 'opencode-owned:sync-fixture';
    const sessionDir = join(ownedRoot, 'sync-fixture');
    const runsDir = join(sessionDir, 'runs');
    const stdoutPath = join(runsDir, 'run.stdout.jsonl');
    const stderrPath = join(runsDir, 'run.stderr.log');
    const now = new Date().toISOString();
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(stdoutPath, Array.from({ length: 75 }, (_, index) => JSON.stringify({
      type: 'text',
      part: { text: `OpenCode answer ${index}` },
      timestamp: now,
    })).join('\n'));
    writeFileSync(stderrPath, '');
    writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({
      surfaceId: sessionKey,
      sessionDir,
      cwd: dataDir,
      repoPath: dataDir,
      title: 'OpenCode sync fixture',
      createdAt: now,
      updatedAt: now,
      latestPrompt: 'test sync',
      latestSummary: 'done',
      recentRuns: [{
        id: 'run-sync-fixture',
        mode: 'launch',
        prompt: 'test sync',
        startedAt: now,
        finishedAt: now,
        pid: 1,
        stdoutPath,
        stderrPath,
        outcome: 'finished',
      }],
    }));

    const response = await POST(syncRequest({ sessionKey, limit: 200 }));
    const payload = await response.json() as {
      history?: { entries?: Array<{ id: string; text: string }>; replace?: boolean };
    };

    expect(response.status).toBe(200);
    expect(payload.history?.replace).not.toBe(true);
    const answers = payload.history?.entries?.filter((entry) => entry.text.startsWith('OpenCode answer')) ?? [];
    expect(answers).toHaveLength(75);
    expect(answers.at(0)?.text).toBe('OpenCode answer 0');
    expect(answers.at(-1)?.text).toBe('OpenCode answer 74');
  });

  it('keeps owned Codex turns beyond the legacy eight-run group window', async () => {
    const sessionKey = 'codex-owned:sync-codex-fixture';
    const sessionDir = join(ownedCodexRoot, 'sync-codex-fixture');
    const runsDir = join(sessionDir, 'runs');
    const now = new Date().toISOString();
    mkdirSync(runsDir, { recursive: true });
    const recentRuns = Array.from({ length: 12 }, (_, index) => {
      const stdoutPath = join(runsDir, `run-${index}.stdout.jsonl`);
      const stderrPath = join(runsDir, `run-${index}.stderr.log`);
      writeFileSync(stdoutPath, JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: `Codex answer ${index}` },
        timestamp: now,
      }));
      writeFileSync(stderrPath, '');
      return {
        id: `run-${index}`,
        mode: index === 0 ? 'launch' : 'resume',
        prompt: `Codex prompt ${index}`,
        startedAt: new Date(Date.parse(now) + index).toISOString(),
        finishedAt: new Date(Date.parse(now) + index).toISOString(),
        pid: 1,
        stdoutPath,
        stderrPath,
        outcome: 'finished',
      };
    });
    writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({
      surfaceId: sessionKey,
      sessionDir,
      cwd: dataDir,
      repoPath: dataDir,
      title: 'Codex sync fixture',
      createdAt: now,
      updatedAt: now,
      latestPrompt: 'test sync',
      latestSummary: 'done',
      recentRuns,
    }));

    const response = await POST(syncRequest({ sessionKey, limit: 200 }));
    const payload = await response.json() as {
      history?: { entries?: Array<{ text: string }> };
    };
    const text = payload.history?.entries?.map((entry) => entry.text) ?? [];

    expect(response.status).toBe(200);
    expect(text).toContain('Codex prompt 0');
    expect(text).toContain('Codex answer 0');
    expect(text).toContain('Codex prompt 11');
    expect(text).toContain('Codex answer 11');
  });

  it('returns all 75 messages from a native discovered Codex session', async () => {
    const threadId = 'sync-discovered-codex-fixture';
    const sessionKey = `codex:${threadId}`;
    const sessionsRoot = join(nativeCodexRoot, 'sessions');
    const rolloutDir = join(sessionsRoot, '2026', '08', '12');
    const rolloutPath = join(rolloutDir, `rollout-${threadId}.jsonl`);
    const stateDbPath = join(nativeCodexRoot, 'state_5.sqlite');
    const now = Date.parse('2026-08-12T12:00:00.000Z');
    mkdirSync(rolloutDir, { recursive: true });
    writeFileSync(rolloutPath, `${Array.from({ length: 75 }, (_, index) => JSON.stringify({
      timestamp: new Date(now + index).toISOString(),
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: `Discovered Codex answer ${index}` }],
      },
    })).join('\n')}\n`);

    const sqlString = (value: string) => `'${value.replace(/'/g, "''")}'`;
    execFileSync('sqlite3', [stateDbPath, [
      'CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, updated_at INTEGER, rollout_path TEXT, git_branch TEXT, git_sha TEXT, git_origin_url TEXT, first_user_message TEXT, model TEXT, archived INTEGER);',
      'CREATE TABLE logs (thread_id TEXT, process_uuid TEXT, ts INTEGER);',
      `INSERT INTO threads VALUES (${sqlString(threadId)}, 'Discovered sync fixture', ${sqlString(dataDir)}, ${Math.floor(now / 1000)}, ${sqlString(rolloutPath)}, '', '', '', 'sync fixture', 'gpt-5', 0);`,
    ].join('\n')]);

    const response = await POST(syncRequest({ sessionKey, limit: 200 }));
    const payload = await response.json() as {
      history?: { entries?: Array<{ text: string }>; replace?: boolean };
    };

    expect(response.status).toBe(200);
    expect(payload.history?.replace).not.toBe(true);
    expect(payload.history?.entries).toHaveLength(75);
    expect(payload.history?.entries?.at(0)?.text).toBe('Discovered Codex answer 0');
    expect(payload.history?.entries?.at(-1)?.text).toBe('Discovered Codex answer 74');
  });

  it('does not publish an authoritative empty snapshot for unsupported sessions', async () => {
    const response = await POST(syncRequest({ sessionKey: 'cloud:unknown-session', limit: 200 }));
    const payload = await response.json() as {
      history?: unknown;
      errors?: { history?: string };
    };

    expect(response.status).toBe(200);
    expect(payload.history).toBeUndefined();
    expect(payload.errors?.history).toContain('unsupported');
  });

  it('returns up to the shared 200-entry retention ceiling and a non-destructive delta', async () => {
    const tabId = 'sync-long-history';
    const entries = Array.from({ length: 75 }, (_, index) => ({
      id: `entry-${index}`,
      role: 'assistant' as const,
      content: `Answer ${index}`,
      timestamp: index + 1,
    }));
    writePersistedLlmChat(tabId, { messages: entries }, { replace: true });

    const snapshotResponse = await POST(syncRequest({
      sessionKey: `llm-chat:${tabId}`,
      limit: 200,
    }));
    const snapshot = await snapshotResponse.json() as {
      history: { entries: Array<{ id: string }>; replace?: boolean };
    };
    expect(snapshot.history.entries).toHaveLength(75);
    expect(snapshot.history.replace).not.toBe(true);

    writePersistedLlmChat(tabId, {
      messages: [{
        id: 'entry-75',
        role: 'assistant',
        content: 'Answer 75',
        timestamp: 76,
      }],
    });
    const deltaResponse = await POST(syncRequest({
      sessionKey: `llm-chat:${tabId}`,
      sinceId: 'entry-74',
      limit: 200,
    }));
    const delta = await deltaResponse.json() as {
      history: { entries: Array<{ id: string }>; replace?: boolean };
    };
    expect(delta.history).toEqual({
      sessionKey: `llm-chat:${tabId}`,
      entries: [expect.objectContaining({ id: 'entry-75' })],
    });
  });
});
