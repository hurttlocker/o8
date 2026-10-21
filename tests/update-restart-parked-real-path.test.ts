/**
 * #3722: an operator restart is blocked by live work, but not by tasks that are
 * only waiting for review or input. Lanes are persisted in an isolated database
 * and read back through the real GET /api/panel/update/apply route.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'o8-update-parked-'));
const previous = { CORTEX_IDE_DATA_DIR: process.env.CORTEX_IDE_DATA_DIR, O8_DATA_DIR: process.env.O8_DATA_DIR, O8_WS_PORT: process.env.O8_WS_PORT };
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;

// The idle window reads the live terminal inventory from the WebSocket server.
// This fixture answers that one route with no attached terminals.
let terminals: Server;
beforeAll(async () => {
  terminals = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(request.url === '/terminal-voice-sessions' ? JSON.stringify({ sessions: [] }) : '{}');
  });
  await new Promise<void>(resolve => terminals.listen(0, '127.0.0.1', resolve));
  process.env.O8_WS_PORT = String((terminals.address() as AddressInfo).port);
});

afterAll(async () => {
  await new Promise<void>(resolve => terminals.close(() => resolve()));
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(dataDir, { recursive: true, force: true });
});

const { createLane, setLaneStatus, getLane } = await import('@/lib/lane/registry');
const { GET } = await import('@/app/api/panel/update/apply/route');
const { describeUpdateBlockers } = await import('@/components/desktop/UpdateCard');

type IdlePayload = Parameters<typeof describeUpdateBlockers>[0] & {
  idle: { idle: boolean; idleExceptParked: boolean; parkedLanes: Array<{ label: string; status: string }> };
};

async function readIdle(): Promise<IdlePayload> {
  const response = await GET();
  expect(response.status).toBe(200);
  return await response.json() as IdlePayload;
}

function lane(label: string, status: Parameters<typeof setLaneStatus>[1]) {
  const created = createLane({ repoPath: join(dataDir, 'repo'), branch: `b-${label.replace(/\W+/g, '-')}`, runtime: 'codex', label });
  setLaneStatus(created.id, status, 'system');
  return created.id;
}

describe('update restart with parked tasks', () => {
  it('lets a confirmed restart pass tasks waiting for review or input, names them, and leaves them untouched', async () => {
    const reviewing = lane('Fix the login form', 'reviewing');
    const waiting = lane('Ask about the schema', 'awaiting_input');

    const payload = await readIdle();
    expect(payload.idle.idle).toBe(false);
    expect(payload.idle.idleExceptParked).toBe(true);
    expect(payload.idle.parkedLanes.map(item => item.label).sort()).toEqual(['Ask about the schema', 'Fix the login form']);
    expect(describeUpdateBlockers(payload)).toEqual({
      live: [],
      parked: expect.arrayContaining(['Fix the login form (waiting for review)', 'Ask about the schema (waiting for input)']),
    });

    // Checking the restart gate does not change the waiting tasks.
    expect(getLane(reviewing)?.status).toBe('reviewing');
    expect(getLane(waiting)?.status).toBe('awaiting_input');
  });

  it('keeps blocking a restart while a task is running, and names it as live work', async () => {
    const running = lane('Build the release', 'running');
    const payload = await readIdle();
    expect(payload.idle.idle).toBe(false);
    expect(payload.idle.idleExceptParked).toBe(false);
    const blockers = describeUpdateBlockers(payload);
    expect(blockers.live).toEqual(['Build the release (running)']);
    expect(blockers.parked).toHaveLength(2);
    setLaneStatus(running, 'completed', 'system');
    expect((await readIdle()).idle.idleExceptParked).toBe(true);
  });
});
