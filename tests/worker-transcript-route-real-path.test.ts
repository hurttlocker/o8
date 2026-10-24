import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mapPacketTranscriptEntries } from '@/components/desktop/workspace-terminal/use-packet-transcript-poll';
import { WorkspaceTranscript } from '@/components/desktop/workspace-terminal/WorkspaceTranscript';
import type { TranscriptEvent } from '@/lib/orchestrator/transcript-normalizer';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const dataDir = process.env.CORTEX_IDE_DATA_DIR!;
const ownedRoot = path.join(dataDir, 'worker-pane-owned-opencode');
const laneWorktree = path.join(dataDir, 'worker-pane-lane-worktree');
process.env.O8_OWNED_OPENCODE_ROOT = ownedRoot;
const codexRoot = path.join(dataDir, 'worker-pane-owned-codex');
const providerRoot = path.join(dataDir, 'worker-pane-provider');
process.env.CORTEX_IDE_OWNED_CODEX_ROOT = codexRoot;
process.env.CODEX_HOME = providerRoot;

const { GET: getPacketTranscript } = await import('@/app/api/orchestrator/packet-transcript/route');
const { createLane, deleteLane } = await import('@/lib/lane/registry');

const sessionKey = 'opencode-owned:worker-pane-real-path';
const packetId = 'packet-worker-pane-real-path';
const command = 'grep -n "packet transcript" src/worker.ts';
const sessionDir = path.join(ownedRoot, 'worker-pane-real-path');
const runsDir = path.join(sessionDir, 'runs');
const stdoutPath = path.join(runsDir, 'run.stdout.jsonl');
const stderrPath = path.join(runsDir, 'run.stderr.log');
const startedAt = '2026-08-23T04:00:00.000Z';
let laneId: string;

function request(): NextRequest {
  return new NextRequest(
    `http://localhost:3001/api/orchestrator/packet-transcript?packetId=${packetId}&tail=1&limit=200`,
    { method: 'GET', headers: { host: 'localhost:3001' } },
  );
}

function writePersistedFirstBurst(): void {
  rmSync(sessionDir, { recursive: true, force: true });
  mkdirSync(runsDir, { recursive: true });
  const run = {
    id: 'run-worker-pane',
    mode: 'launch' as const,
    prompt: 'Verify the worker transcript pane.',
    startedAt,
    pid: 2_147_483_647,
    stdoutPath,
    stderrPath,
    outcome: 'running' as const,
  };
  writeFileSync(stdoutPath, [
    JSON.stringify({ type: 'step_start', timestamp: startedAt, sessionID: 'ses_worker_pane' }),
    JSON.stringify({
      type: 'tool_use',
      timestamp: '2026-08-23T04:00:01.000Z',
      part: {
        type: 'tool',
        tool: 'shell',
        callID: 'call-shell-1',
        state: { status: 'pending', input: { command } },
      },
    }),
    JSON.stringify({
      type: 'step_finish',
      timestamp: '2026-08-23T04:00:02.000Z',
      part: { type: 'step-finish', reason: 'tool-calls' },
    }),
  ].join('\n') + '\n');
  writeFileSync(stderrPath, '');
  writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify({
    surfaceId: sessionKey,
    sessionDir,
    cwd: dataDir,
    repoPath: dataDir,
    title: 'Worker transcript fixture',
    createdAt: startedAt,
    updatedAt: startedAt,
    latestPrompt: run.prompt,
    latestSummary: 'running',
    activeRun: run,
    recentRuns: [run],
  }));
}

describe('worker transcript persisted packet route', () => {
  beforeAll(() => {
    mkdirSync(laneWorktree, { recursive: true });
    writePersistedFirstBurst();
    const lane = createLane({
      repoPath: dataDir,
      worktreePath: laneWorktree,
      branch: 'inline/worker-transcript-fixture',
      runtime: 'opencode',
      packetId,
      sessionKey,
    });
    laneId = lane.id;
  });

  afterAll(() => {
    rmSync(codexRoot, { recursive: true, force: true });
    rmSync(providerRoot, { recursive: true, force: true });
    rmSync(ownedRoot, { recursive: true, force: true });
    rmSync(laneWorktree, { recursive: true, force: true });
    deleteLane(laneId);
  });

  it('returns a structured tool event without projecting the step_finish reason', async () => {
    const response = await getPacketTranscript(request());
    expect(response.status).toBe(200);
    const payload = await response.json() as {
      events: Array<Record<string, unknown>>;
    };

    expect(payload.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'tool_call',
        tool: 'shell',
        args: JSON.stringify({ command }),
      }),
    ]));
    expect(payload.events.some((event) => (
      event.type === 'assistant' && event.text === 'tool-calls'
    ))).toBe(false);
  });

  it('returns events appended after the first route read', async () => {
    const firstResponse = await getPacketTranscript(request());
    const firstPayload = await firstResponse.json() as { events: Array<Record<string, unknown>> };
    expect(firstPayload.events.some((event) => event.text === 'Second burst reached the pane.')).toBe(false);

    appendFileSync(stdoutPath, [
      JSON.stringify({
        type: 'text',
        timestamp: '2026-08-23T04:00:03.000Z',
        part: { type: 'text', text: 'Second burst reached the pane.' },
      }),
      JSON.stringify({
        type: 'step_finish',
        timestamp: '2026-08-23T04:00:04.000Z',
        part: { type: 'step-finish', reason: 'stop' },
      }),
    ].join('\n') + '\n');

    const secondResponse = await getPacketTranscript(request());
    const secondPayload = await secondResponse.json() as { events: Array<Record<string, unknown>> };
    expect(secondPayload.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'assistant', text: 'Second burst reached the pane.' }),
    ]));
  });

  it('emits one call and one result while a tool part advances status', async () => {
    const callID = 'call-status-progression';
    const timestamp = '2026-08-23T04:00:05.000Z';
    appendFileSync(stdoutPath, ['idle', 'running', 'completed'].map((status) => JSON.stringify({
      type: 'tool_use',
      timestamp,
      part: {
        type: 'tool',
        tool: 'shell',
        callID,
        state: {
          status,
          input: { command: 'git status --short' },
          ...(status === 'completed' ? { output: 'clean' } : {}),
        },
      },
    })).join('\n') + '\n');

    const response = await getPacketTranscript(request());
    const payload = await response.json() as { events: Array<Record<string, unknown>> };
    const matchingCalls = payload.events.filter((event) => (
      event.type === 'tool_call' && event.args === JSON.stringify({ command: 'git status --short' })
    ));
    const matchingResults = payload.events.filter((event) => (
      event.type === 'tool_result' && event.summary === 'clean'
    ));

    expect(matchingCalls).toHaveLength(1);
    expect(matchingResults).toHaveLength(1);
  });
});


describe('owned Codex worker pane event identity and time', () => {
  it('reads original rollout times over an hour and keeps one tool per call on reopen', async () => {
    const sessionKey = 'codex-owned:event-times';
    const threadId = 'worker-event-times';
    const sessionDir = path.join(codexRoot, 'event-times');
    const stdoutPath = path.join(sessionDir, 'run.jsonl');
    const rolloutPath = path.join(providerRoot, 'sessions', 'rollout.jsonl');
    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(path.dirname(rolloutPath), { recursive: true });
    const times = ['2026-10-21T12:00:00.000Z', '2026-10-21T12:01:00.000Z',
      '2026-10-21T13:02:00.000Z', '2026-10-21T13:03:00.000Z'];
    const lines = times.map((timestamp, index) => ({ timestamp, type: 'response_item', payload: index % 2 === 0
      ? { type: 'function_call', call_id: `call-${index}`, name: 'exec_command', arguments: 'git status --short' }
      : { type: 'function_call_output', call_id: `call-${index - 1}`, output: 'clean', exit_code: 0 } }));
    const assistantAt = '2026-10-21T13:04:00.000Z';
    const rollout = [...lines.flatMap((line, index) => index % 2 === 0 ? [line, { timestamp: line.timestamp, type: 'event_msg', payload: { type: 'exec_command_begin', call_id: `alias-${index}`, command: 'git status --short' } }] : [line]), { timestamp: assistantAt, type: 'event_msg', payload: { type: 'agent_message', message: 'Finished checking.' } }];
    writeFileSync(rolloutPath, rollout.map(line => JSON.stringify(line)).join('\n') + '\n');
    // Exec stdout lacks event times; the durable rollout carries the originals.
    writeFileSync(stdoutPath, rollout.map(({ timestamp: _timestamp, ...line }) => JSON.stringify(line)).join('\n') + '\n');
    writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify({
      surfaceId: sessionKey, sessionDir, threadId, cwd: dataDir, repoPath: dataDir,
      title: 'Worker event times', createdAt: times[0], updatedAt: assistantAt,
      latestPrompt: 'Check status', latestSummary: 'Finished checking.', activeRun: null,
      recentRuns: [{ id: 'run', mode: 'launch', prompt: 'Check status', startedAt: times[0],
        finishedAt: assistantAt, stdoutPath, stderrPath: path.join(sessionDir, 'stderr.log'), outcome: 'completed' }],
    }));
    const db = new Database(path.join(providerRoot, 'state_5.sqlite'));
    db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, updated_at INTEGER,
      rollout_path TEXT, git_branch TEXT, git_sha TEXT, git_origin_url TEXT,
      first_user_message TEXT, model TEXT, archived INTEGER)`);
    db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      threadId, 'Worker event times', dataDir, 1, rolloutPath, 'fixture', '', '', 'Check status', 'fixture', 0);
    db.close();

    const read = async () => {
      const response = await getPacketTranscript(new NextRequest(
        `http://localhost/api/orchestrator/packet-transcript?sessionKey=${sessionKey}&tail=1&limit=200`, { headers: { host: 'localhost' } }));
      expect(response.status).toBe(200);
      return (await response.json() as { events: TranscriptEvent[] }).events;
    };
    const events = await read();
    expect(events.filter(event => event.type === 'tool_call')).toHaveLength(2);
    expect(events.map(event => event.ts)).toEqual([...times, assistantAt]);
    const entries = mapPacketTranscriptEntries(events);
    const html = renderToStaticMarkup(createElement(WorkspaceTranscript, { entries: entries.map(entry => ({ ...entry, text: '' })), isStreaming: true }))
      + renderToStaticMarkup(createElement(WorkspaceTranscript, { entries }));
    expect(html.match(/data-activity-command/g)).toHaveLength(2);
    for (const timestamp of [times[0], times[2], assistantAt]) expect(html).toContain(`dateTime="${timestamp}"`);
    expect(await read()).toEqual(events);
  });
});
