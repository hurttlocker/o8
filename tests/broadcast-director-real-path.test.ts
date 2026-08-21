import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@clerk/nextjs/server', () => ({
  clerkMiddleware: (handler: unknown) => handler,
}));

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-broadcast-director-'));
const operatorToken = 'broadcast-director-operator-token-0123456789';
writeFileSync(path.join(dataDir, 'ws-token'), `${operatorToken}\n`, 'utf8');
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const { getSqlite } = await import('@/lib/db');
const { appendBroadcastEvent } = await import('@/lib/broadcast/post');
const { runBroadcastDirectorOnce } = await import('@/lib/broadcast/director');
const eventsRoute = await import('@/app/api/broadcast/events/route');
const commentaryRoute = await import('@/app/api/broadcast/commentary/route');

const intervalSettings = {
  broadcastCommentary: 'interval' as const,
  intervalMinutes: 4,
  minNewEvents: 3,
  maxPerHour: 12,
};

function postConversation(text: string, now: Date): void {
  appendBroadcastEvent({
    kind: 'conversation',
    actor: 'operator',
    audience: 'agents',
    text,
  }, { sqlite: getSqlite(), now });
}

function operatorRequest(url: string): NextRequest {
  return new NextRequest(url, {
    headers: {
      host: 'localhost:3001',
      authorization: `Bearer ${operatorToken}`,
    },
  });
}

describe('Broadcast director real path', () => {
  it('enforces event, interval, and hourly bounds before commentary reaches both GET routes', async () => {
    const start = new Date('2026-08-21T20:00:00.000Z');
    postConversation('First external exchange.', new Date(start.getTime() - 3_000));
    postConversation('Second external exchange.', new Date(start.getTime() - 2_000));

    const runner = vi.fn(async () => 'Two operator exchanges landed, and the feed is moving again.');
    await expect(runBroadcastDirectorOnce({
      sqlite: getSqlite(),
      now: start,
      settings: intervalSettings,
      runner,
      model: 'gpt-test',
      reasoningEffort: 'low',
    })).resolves.toMatchObject({ status: 'skipped', reason: 'min_new_events', newEventCount: 2 });
    expect(runner).not.toHaveBeenCalled();

    postConversation('Third external exchange.', new Date(start.getTime() - 1_000));
    await expect(runBroadcastDirectorOnce({
      sqlite: getSqlite(),
      now: start,
      settings: intervalSettings,
      runner,
      model: 'gpt-test',
      reasoningEffort: 'low',
    })).resolves.toMatchObject({ status: 'posted', reason: 'posted', newEventCount: 3 });
    expect(runner).toHaveBeenCalledTimes(1);

    await expect(runBroadcastDirectorOnce({
      sqlite: getSqlite(),
      now: new Date(start.getTime() + 60_000),
      settings: intervalSettings,
      runner,
      model: 'gpt-test',
    })).resolves.toMatchObject({ status: 'skipped', reason: 'interval' });

    postConversation('Fourth external exchange.', new Date(start.getTime() + 4 * 60_000 + 1_000));
    postConversation('Fifth external exchange.', new Date(start.getTime() + 4 * 60_000 + 2_000));
    postConversation('Sixth external exchange.', new Date(start.getTime() + 4 * 60_000 + 3_000));
    await expect(runBroadcastDirectorOnce({
      sqlite: getSqlite(),
      now: new Date(start.getTime() + 5 * 60_000),
      settings: { ...intervalSettings, maxPerHour: 1 },
      runner,
      model: 'gpt-test',
    })).resolves.toMatchObject({ status: 'skipped', reason: 'max_per_hour' });
    expect(runner).toHaveBeenCalledTimes(1);

    const feedResponse = await eventsRoute.GET(operatorRequest(
      'http://localhost:3001/api/broadcast/events?kinds=commentary',
    ));
    expect(feedResponse.status).toBe(200);
    await expect(feedResponse.json()).resolves.toMatchObject({
      events: [{
        source: 'broadcast',
        kind: 'commentary',
        actor: 'mister',
        detail: 'Two operator exchanges landed, and the feed is moving again.',
      }],
    });

    const firstSpeech = commentaryRoute.GET(operatorRequest(
      'http://localhost:3001/api/broadcast/commentary',
    ));
    expect(firstSpeech.status).toBe(200);
    const speechPage = await firstSpeech.json() as { cursor: string; commentary: Array<{ text: string }> };
    expect(speechPage.commentary).toEqual([
      { id: expect.any(String), actor: 'mister', text: 'Two operator exchanges landed, and the feed is moving again.', timestamp: start.toISOString() },
    ]);
    const nextSpeech = commentaryRoute.GET(operatorRequest(
      `http://localhost:3001/api/broadcast/commentary?since=${encodeURIComponent(speechPage.cursor)}`,
    ));
    await expect(nextSpeech.json()).resolves.toMatchObject({ commentary: [] });
  });
});
