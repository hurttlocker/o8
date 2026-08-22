import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'o8-codex-transcript-tail-'));
const ownedCodexRoot = join(dataDir, 'owned-codex');
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.CORTEX_IDE_OWNED_CODEX_ROOT = ownedCodexRoot;

const { POST } = await import('@/app/api/mobile/sync/route');
const {
  latestTranscriptEventAt,
  readSessionTranscriptEvents,
} = await import('@/lib/orchestrator/packet-transcript');
const {
  RUNNING_TRANSCRIPT_STALL_MS,
  classifyLaneTranscriptFault,
} = await import('@/lib/lane/transcript-health');

function syncRequest(sessionKey: string, sinceId?: string) {
  return new NextRequest('http://localhost:3001/api/mobile/sync', {
    method: 'POST',
    body: JSON.stringify({ history: { sessionKey, sinceId, limit: 200 } }),
    headers: { 'Content-Type': 'application/json' },
  });
}

async function readSync(sessionKey: string, sinceId?: string) {
  const response = await POST(syncRequest(sessionKey, sinceId));
  expect(response.status).toBe(200);
  return response.json() as Promise<{
    history: {
      sessionKey: string;
      entries: Array<{ id: string; text: string }>;
      replace?: boolean;
    };
  }>;
}

async function transcriptActivityAt(sessionKey: string) {
  const readback = await readSessionTranscriptEvents(sessionKey);
  return latestTranscriptEventAt(readback.events);
}

async function waitForMtimeTick() {
  await new Promise((resolve) => setTimeout(resolve, 15));
}

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('owned Codex run-log transcript ingestion real path', () => {
  it('streams every later append through mobile sync and advances transcript activity', async () => {
    const sessionId = 'codex-owned-live-append';
    const sessionKey = `codex-owned:${sessionId}`;
    const sessionDir = join(ownedCodexRoot, sessionId);
    const runsDir = join(sessionDir, 'runs');
    const stdoutPath = join(runsDir, 'live.stdout.jsonl');
    const stderrPath = join(runsDir, 'live.stderr.log');
    const startedAt = new Date(Date.now() - 10_000).toISOString();
    const run = {
      id: 'live-run',
      mode: 'launch',
      prompt: 'Keep streaming the fake worker transcript.',
      startedAt,
      pid: process.pid,
      stdoutPath,
      stderrPath,
      outcome: 'running',
    } as const;

    mkdirSync(runsDir, { recursive: true });
    writeFileSync(stdoutPath, `${JSON.stringify({
      type: 'item.started',
      item: { id: 'command-1', type: 'command_execution', command: '/bin/echo first' },
    })}\n`);
    writeFileSync(stderrPath, '');
    writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({
      surfaceId: sessionKey,
      sessionDir,
      cwd: dataDir,
      repoPath: dataDir,
      title: 'Live append fixture',
      createdAt: startedAt,
      updatedAt: startedAt,
      latestPrompt: run.prompt,
      latestSummary: 'running',
      activeRun: run,
      recentRuns: [run],
    }));

    const first = await readSync(sessionKey);
    expect(first.history.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: 'Running /bin/echo first' }),
    ]));
    const firstCursor = first.history.entries.at(-1)!.id;
    const firstActivityAt = await transcriptActivityAt(sessionKey);
    expect(firstActivityAt).not.toBeNull();

    await waitForMtimeTick();
    appendFileSync(stdoutPath, `${JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'command-1',
        type: 'command_execution',
        command: '/bin/echo first',
        aggregated_output: 'first',
        exit_code: 0,
      },
    })}\n`);
    const second = await readSync(sessionKey, firstCursor);
    expect(second.history.replace).not.toBe(true);
    expect(second.history.entries).toEqual([
      expect.objectContaining({ text: 'Run /bin/echo first' }),
    ]);
    const secondCursor = second.history.entries.at(-1)!.id;
    const secondActivityAt = await transcriptActivityAt(sessionKey);
    expect(Date.parse(secondActivityAt!)).toBeGreaterThan(Date.parse(firstActivityAt!));

    await waitForMtimeTick();
    appendFileSync(stdoutPath, `${JSON.stringify({
      type: 'item.completed',
      item: { id: 'message-1', type: 'agent_message', text: 'Still working after the first burst.' },
    })}\n`);
    const third = await readSync(sessionKey, secondCursor);
    expect(third.history.replace).not.toBe(true);
    expect(third.history.entries).toEqual([
      expect.objectContaining({ text: 'Still working after the first burst.' }),
    ]);
    const thirdActivityAt = await transcriptActivityAt(sessionKey);
    expect(Date.parse(thirdActivityAt!)).toBeGreaterThan(Date.parse(secondActivityAt!));
  });

  it('surfaces a running lane whose transcript has not advanced past the threshold', () => {
    const now = Date.now();
    const fault = classifyLaneTranscriptFault({
      status: 'running',
      createdAt: new Date(now - RUNNING_TRANSCRIPT_STALL_MS - 1).toISOString(),
      lastEventAt: null,
    }, {
      lastTranscriptAt: null,
      readFailed: false,
    }, now);

    expect(fault).toEqual(expect.objectContaining({
      code: 'transcript_stalled',
      thresholdMs: RUNNING_TRANSCRIPT_STALL_MS,
    }));
  });
});
