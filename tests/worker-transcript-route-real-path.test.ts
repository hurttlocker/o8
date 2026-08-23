import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const dataDir = process.env.CORTEX_IDE_DATA_DIR!;
const ownedRoot = path.join(dataDir, 'worker-pane-owned-opencode');
process.env.O8_OWNED_OPENCODE_ROOT = ownedRoot;

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
    writePersistedFirstBurst();
    const lane = createLane({
      repoPath: dataDir,
      worktreePath: dataDir,
      branch: 'inline/worker-transcript-fixture',
      runtime: 'opencode',
      packetId,
      sessionKey,
    });
    laneId = lane.id;
  });

  afterAll(() => {
    deleteLane(laneId);
    rmSync(ownedRoot, { recursive: true, force: true });
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
});
