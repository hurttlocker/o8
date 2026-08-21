/**
 * Broadcast follow-up proofs through the real spectator route handlers.
 * The projection and credential files resolve their data directory at import,
 * so the fixture is established before the dynamic route imports below.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-broadcast-followup-'));
const SPECTATOR_TOKEN = 'broadcast-followup-spectator-token-0123456789';
const SHORT_DEVICE_TOKEN = 'dv!43y';
writeFileSync(join(dataDir, 'ws-token'), 'operator-broadcast-followup-token-0123456789\n', 'utf8');
writeFileSync(
  join(dataDir, 'mobile-device-tokens'),
  `${createHash('sha256').update(SHORT_DEVICE_TOKEN).digest('hex')}\n`,
  'utf8',
);
writeFileSync(
  join(dataDir, 'broadcast-spectator-tokens'),
  `${createHash('sha256').update(SPECTATOR_TOKEN).digest('hex')}\n`,
  'utf8',
);
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const broadcastEvents = await import('@/app/api/broadcast/events/route');
const broadcastSnapshot = await import('@/app/api/broadcast/snapshot/route');
const { decodeBroadcastCursor } = await import('@/lib/broadcast/events');
const { getSqlite } = await import('@/lib/db');
const { appendEvent, createLane } = await import('@/lib/lane/registry');

function spectatorRequest(path: string): NextRequest {
  return new NextRequest(`http://localhost:3001${path}`, {
    method: 'GET',
    headers: {
      host: 'localhost:3001',
      authorization: `Bearer ${SPECTATOR_TOKEN}`,
    },
  });
}

afterEach(() => {
  delete process.env.O8_BROADCAST_TEST_AUTH;
  delete process.env.WS_TOKEN;
});

describe('Broadcast follow-up bounds and redaction through real routes', () => {
  it('redacts sensitive keys plus live operator, device, and short secret environment values', async () => {
    const shortOperatorToken = 'op!42x';
    const shortEnvironmentSecret = 'ev!44z';
    process.env.WS_TOKEN = shortOperatorToken;
    process.env.O8_BROADCAST_TEST_AUTH = shortEnvironmentSecret;
    // A flag-sized value under a secret-looking key must not scrub digits out
    // of ordinary text ("#1800" once rendered as "#[redacted-env]800").
    process.env.O8_BROADCAST_TEST_FLAG_TOKEN = '1';
    // Long values under ordinary keys are not secrets (NODE_ENV=production).
    process.env.O8_BROADCAST_TEST_MODE = 'production';
    const lane = createLane({
      label: 'Broadcast redaction route',
      repoPath: '/tmp/broadcast-redaction-route',
      branch: `agent/broadcast-redaction-${Date.now()}`,
      baseBranch: 'main',
      runtime: 'codex',
      packetId: `packet-broadcast-redaction-${Date.now()}`,
    });
    const sensitiveValues = {
      cookie: 'raw-cookie-shape',
      pw: 'raw-pw-shape',
      auth: 'raw-auth-shape',
      sessionKey: 'raw-session-camel-shape',
      session_key: 'raw-session-snake-shape',
      'ws-token': 'raw-ws-dash-shape',
      ws_token: 'raw-ws-snake-shape',
      'device-token': 'raw-device-dash-shape',
      device_token: 'raw-device-snake-shape',
    };
    appendEvent(lane.id, 'agent_report', 'orchestrator', {
      event: 'progress',
      message: 'redaction route proof for #1800 through the production launcher',
      metadata: {
        ...sensitiveValues,
        first: shortOperatorToken,
        second: SHORT_DEVICE_TOKEN,
        third: shortEnvironmentSecret,
      },
    });

    const response = await broadcastEvents.GET(spectatorRequest(
      `/api/broadcast/events?kinds=progress&lane=${encodeURIComponent(lane.id)}`,
    ));
    expect(response.status).toBe(200);
    const serialized = await response.text();
    for (const raw of [
      ...Object.values(sensitiveValues),
      shortOperatorToken,
      SHORT_DEVICE_TOKEN,
      shortEnvironmentSecret,
    ]) {
      expect(serialized).not.toContain(raw);
    }
    expect(serialized).toContain('[redacted');
    expect(serialized).not.toContain('[redacted-env]800');
    expect(serialized).toContain('#1800');
    expect(serialized).toContain('production launcher');
  });

  it('caps a projected event payload at 8 KB and marks it truncated', async () => {
    const lane = createLane({
      label: 'Broadcast payload bound',
      repoPath: '/tmp/broadcast-payload-bound',
      branch: `agent/broadcast-payload-${Date.now()}`,
      baseBranch: 'main',
      runtime: 'codex',
      packetId: `packet-broadcast-payload-${Date.now()}`,
    });
    appendEvent(lane.id, 'agent_report', 'orchestrator', {
      event: 'progress',
      message: `large-payload-${'x'.repeat(64 * 1024)}`,
    });

    const response = await broadcastEvents.GET(spectatorRequest(
      `/api/broadcast/events?kinds=progress&lane=${encodeURIComponent(lane.id)}`,
    ));
    expect(response.status).toBe(200);
    const page = await response.json() as { events: Array<{ payload: Record<string, unknown> }> };
    expect(page.events).toHaveLength(1);
    expect(page.events[0].payload).toMatchObject({ truncated: true });
    expect(Buffer.byteLength(JSON.stringify(page.events[0].payload), 'utf8')).toBeLessThanOrEqual(8 * 1024);
  });

  it('stops after 5,000 non-matching ledger rows and returns a cursor the client can continue', async () => {
    const lane = createLane({
      label: 'Broadcast scan bound',
      repoPath: '/tmp/broadcast-scan-bound',
      branch: `agent/broadcast-scan-${Date.now()}`,
      baseBranch: 'main',
      runtime: 'codex',
      packetId: `packet-broadcast-scan-${Date.now()}`,
    });
    const insert = getSqlite().prepare(`
      INSERT INTO lane_events (id, lane_id, verb, actor, payload_json, timestamp)
      VALUES (?, ?, 'heartbeat', 'system', '{}', ?)
    `);
    getSqlite().transaction(() => {
      const start = Date.parse('2035-01-01T00:00:00.000Z');
      for (let index = 0; index < 6_000; index += 1) {
        insert.run(`broadcast-scan-${lane.id}-${index}`, lane.id, new Date(start + index).toISOString());
      }
    })();

    const firstResponse = await broadcastEvents.GET(spectatorRequest(
      `/api/broadcast/events?kinds=message&lane=${encodeURIComponent(lane.id)}`,
    ));
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json() as { events: unknown[]; cursor: string; hasMore: boolean };
    expect(first.events).toEqual([]);
    expect(first.hasMore).toBe(true);
    const firstCursor = decodeBroadcastCursor(first.cursor);
    expect(firstCursor?.positions.lane).toBeGreaterThan(0);

    const secondResponse = await broadcastEvents.GET(spectatorRequest(
      `/api/broadcast/events?kinds=message&lane=${encodeURIComponent(lane.id)}&cursor=${encodeURIComponent(first.cursor)}`,
    ));
    const second = await secondResponse.json() as { events: unknown[]; cursor: string; hasMore: boolean };
    expect(second.events).toEqual([]);
    expect(second.hasMore).toBe(false);
    expect(second.cursor).not.toBe(first.cursor);
    expect(decodeBroadcastCursor(second.cursor)?.positions.lane).toBeGreaterThan(firstCursor?.positions.lane ?? 0);

    const snapshotResponse = await broadcastSnapshot.GET(spectatorRequest(
      '/api/broadcast/snapshot?events=5',
    ));
    expect(snapshotResponse.status).toBe(200);
    await expect(snapshotResponse.json()).resolves.toMatchObject({ recentEvents: [] });
  });
});
