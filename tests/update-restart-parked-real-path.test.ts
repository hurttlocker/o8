/**
 * #3722: an operator restart is blocked by live work, but not by tasks that are
 * only waiting for review or input. Lanes are persisted in an isolated database
 * and read back through the real GET /api/panel/update/apply route.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const { publishRealtimeMutation } = vi.hoisted(() => ({ publishRealtimeMutation: vi.fn(async () => true) }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation }));
let sessions: unknown[] = [];

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
    response.end(request.url === '/terminal-voice-sessions' ? JSON.stringify({ sessions }) : '{}');
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

const { createLane, setLaneStatus, getLane, attachSession } = await import('@/lib/lane/registry');
const { GET, POST } = await import('@/app/api/panel/update/apply/route');
const { setAppUpdateState } = await import('@/lib/app-update/relaunch-state');
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

async function apply() {
  setAppUpdateState({ updatePending: true, version: '0.1.999' });
  return POST(new Request('http://localhost/api/panel/update/apply', { method: 'POST', body: '{}' }));
}

describe('remote apply with persisted parked lanes', () => {
  it('applies without force and preserves parked records', async () => {
    const id = lane('Persist through restart', 'reviewing');
    const response = await apply();
    expect(response.status).toBe(202);
    const payload = await response.json();
    expect(payload.idle.parkedLanes).toEqual(expect.arrayContaining([expect.objectContaining({ id })]));
    expect(getLane(id)?.status).toBe('reviewing');
    expect(publishRealtimeMutation).toHaveBeenCalled();
  });

  it('blocks a live terminal despite parked-only lanes', async () => {
    sessions = [{ name: 'live-worker', kind: 'managed-process', clientCount: 0 }];
    expect((await apply()).status).toBe(409);
    sessions = [];
  });

  it('blocks a live process even when its lane is reviewing', async () => {
    const id = lane('Review with worker', 'reviewing');
    attachSession(id, 'codex-owned:review-live');
    const directory = join(process.env.CORTEX_IDE_OWNED_CODEX_ROOT!, 'review-live');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'session.json'), JSON.stringify({ surfaceId: 'codex-owned:review-live', activeRun: { pid: process.pid } }));
    const response = await apply();
    expect(response.status).toBe(409);
    const payload = await response.json();
    expect(payload.idle.parkedLanes.map((item: { id: string }) => item.id)).not.toContain(id);
    expect(describeUpdateBlockers(payload).live).toContain('Review with worker (reviewing)');
    setLaneStatus(id, 'completed', 'system');
    rmSync(directory, { recursive: true });
  });

  it('preserves CLI installer admission including force', async () => {
    const lock = join(dataDir, 'fixture-cli-update.lock');
    writeFileSync(lock, 'fixture');
    expect((await apply()).status).toBe(409);
    expect((await POST(new Request('http://localhost/api/panel/update/apply', { method: 'POST', body: JSON.stringify({ force: true }) }))).status).toBe(409);
    rmSync(lock);
  });
});
