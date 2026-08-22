import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@clerk/nextjs/server', () => ({
  clerkMiddleware: (handler: unknown) => handler,
}));

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-broadcast-speaker-'));
const operatorToken = 'broadcast-speaker-operator-token-0123456789';
writeFileSync(path.join(dataDir, 'ws-token'), `${operatorToken}\n`, 'utf8');
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const { getSqlite } = await import('@/lib/db');
const { appendBroadcastEvent } = await import('@/lib/broadcast/post');
const { BroadcastSpeaker } = await import('@/lib/broadcast/speaker');
const { runBroadcastDirectorOnce } = await import('@/lib/broadcast/director');
const { appendEvent, createLane, setLaneStatus } = await import('@/lib/lane/registry');
const { createTestApproval } = await import('@/lib/approvals/store');
const commentaryRoute = await import('@/app/api/broadcast/commentary/route');
const sayRoute = await import('@/app/api/broadcast/say/route');

function operatorRequest(url: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      host: 'localhost:3001',
      authorization: `Bearer ${operatorToken}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function loadCommentary(cursor: string | null) {
  const query = cursor ? `?since=${encodeURIComponent(cursor)}` : '';
  const response = commentaryRoute.GET(operatorRequest(`http://localhost:3001/api/broadcast/commentary${query}`));
  expect(response.status).toBe(200);
  return response.json() as Promise<{
    commentary: Array<{ id: string; actor: string; text: string; timestamp: string; priority: boolean }>;
    cursor: string | null;
    hasMore: boolean;
  }>;
}

const voiceOn = {
  broadcastVoice: 'on' as const,
  lullMinutes: 60,
  maxPerHour: 20,
};

describe('Broadcast speaker real path', () => {
  it('advances the route cursor, prevents overlap, caps the queue, and lets say preempt pending lines', async () => {
    const base = Date.now();
    for (let index = 1; index <= 5; index += 1) {
      appendBroadcastEvent({
        kind: 'commentary',
        actor: 'mister',
        text: `Queued line ${index}.`,
      }, { sqlite: getSqlite(), now: new Date(base + index) });
    }

    let active = 0;
    let maxActive = 0;
    let releaseFirst: () => void = () => undefined;
    const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const spoken: string[] = [];
    const speak = vi.fn(async (text: string) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      spoken.push(text);
      if (spoken.length === 1) await firstHeld;
      active -= 1;
    });
    const speaker = new BroadcastSpeaker({ sqlite: getSqlite(), speak, loadCommentary, includeExisting: true });

    const firstTick = await speaker.tick({ now: new Date(base + 10), settings: voiceOn });
    expect(firstTick.cursor).toEqual(expect.any(String));
    expect(spoken).toEqual(['Queued line 3.']);
    expect(speaker.state()).toMatchObject({ queued: 2, speaking: true });
    expect((getSqlite().prepare(`SELECT COUNT(*) AS count FROM broadcast_events WHERE json_extract(metadata_json, '$.speakerQueueDrop') = 1`).get() as { count: number }).count)
      .toBe(2);

    const sayResponse = await sayRoute.POST(operatorRequest(
      'http://localhost:3001/api/broadcast/say',
      { text: 'Priority line.' },
    ));
    expect(sayResponse.status).toBe(200);
    const priorityPage = await loadCommentary(speaker.state().cursor);
    expect(priorityPage.commentary).toContainEqual(expect.objectContaining({
      text: 'Priority line.',
      priority: true,
    }));
    await speaker.tick({ now: new Date(base + 20), settings: voiceOn });
    expect((speaker as unknown as { queue: Array<{ text: string; priority: boolean }> }).queue.map((line) => ({
      text: line.text,
      priority: line.priority,
    }))).toEqual([
      { text: 'Priority line.', priority: true },
      { text: 'Queued line 4.', priority: false },
      { text: 'Queued line 5.', priority: false },
    ]);
    releaseFirst();
    await speaker.flush();

    expect(spoken).toEqual([
      'Queued line 3.',
      'Priority line.',
      'Queued line 4.',
      'Queued line 5.',
    ]);
    expect(maxActive).toBe(1);
    const empty = await loadCommentary(speaker.state().cursor);
    expect(empty.commentary).toEqual([]);
  });

  it('posts deterministic merge, approval, failure, spend-cap, and one-per-lull commentary through the speaker tick', async () => {
    const lane = createLane({
      label: 'Voice moment packet',
      repoPath: '/tmp/broadcast-speaker-moments',
      branch: `issue/broadcast-speaker-${Date.now()}`,
      baseBranch: 'main',
      runtime: 'codex',
      packetId: `packet-broadcast-speaker-${Date.now()}`,
    });
    setLaneStatus(lane.id, 'running', 'system', 'running');
    appendEvent(lane.id, 'merge', 'system', {});
    appendEvent(lane.id, 'status_change', 'system', { status: 'failed', eventLabel: 'agent_failed' });
    appendEvent(lane.id, 'spend_cap_hit', 'system', { reason: 'Packet spend cap reached.' });
    createTestApproval(`codex:broadcast-speaker-${Date.now()}`);

    const base = new Date(Date.now() + 1_000);
    appendBroadcastEvent({
      kind: 'focus',
      actor: 'operator',
      title: 'Ship the Broadcast voice',
    }, { sqlite: getSqlite(), now: base });

    const spoken: string[] = [];
    const speaker = new BroadcastSpeaker({
      sqlite: getSqlite(),
      speak: async (text) => { spoken.push(text); },
      loadCommentary,
      includeExisting: true,
    });
    const momentTick = await speaker.tick({ now: new Date(base.getTime() + 1_000), settings: voiceOn });
    await speaker.flush();
    expect(momentTick.generated).toHaveLength(4);
    const momentRows = getSqlite().prepare(`
      SELECT text FROM broadcast_events
      WHERE kind = 'commentary' AND json_extract(metadata_json, '$.voiceTrigger') = 'moment'
    `).all() as Array<{ text: string }>;
    expect(momentRows.map((row) => row.text)).toEqual(expect.arrayContaining([
      'Merge landed for Voice moment packet.',
      'Approval needed for Execute shell command.',
      'Voice moment packet failed and needs attention.',
      'Spend cap hit for Voice moment packet; work is held.',
    ]));

    appendBroadcastEvent({
      kind: 'conversation',
      actor: 'operator',
      text: 'Reset the lull clock.',
    }, { sqlite: getSqlite(), now: new Date(base.getTime() + 2_000) });
    await speaker.tick({ now: new Date(base.getTime() + 2_000), settings: { ...voiceOn, lullMinutes: 6 } });
    await speaker.tick({ now: new Date(base.getTime() + 6 * 60_000 + 2_001), settings: { ...voiceOn, lullMinutes: 6 } });
    await speaker.flush();
    await speaker.tick({ now: new Date(base.getTime() + 7 * 60_000 + 2_001), settings: { ...voiceOn, lullMinutes: 6 } });
    await speaker.flush();

    const lullRows = getSqlite().prepare(`
      SELECT text FROM broadcast_events
      WHERE kind = 'commentary' AND json_extract(metadata_json, '$.voiceTrigger') = 'lull'
    `).all() as Array<{ text: string }>;
    expect(lullRows).toEqual([{
      text: 'Still on Ship the Broadcast voice; 1 lane running, waiting on review.',
    }]);
    expect(new Set(spoken).size).toBe(spoken.length);

    await expect(runBroadcastDirectorOnce({
      sqlite: getSqlite(),
      now: new Date(base.getTime() + 7 * 60_000 + 3_000),
      settings: {
        broadcastCommentary: 'interval',
        intervalMinutes: 1,
        minNewEvents: 1,
        maxPerHour: 5,
      },
      runner: vi.fn(async () => 'This should stay capped.'),
      model: 'gpt-test',
    })).resolves.toMatchObject({ status: 'skipped', reason: 'max_per_hour' });
  });
});
