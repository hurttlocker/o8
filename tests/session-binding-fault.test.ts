/**
 * Session-binding fault detector (#1502), driven through the REAL heartbeat and
 * progress-report route handlers. A worker that heartbeats/reports while its
 * lane carries a NULL sessionKey is "running into the void" — no transcript, and
 * every completion misfires the silent-exit detector. The detector must convert
 * that invisible hole into a visible fault.
 *
 * We POST a constructed Request to the actual routes (not the detector in
 * isolation) and assert the observable effects: a `no_session_binding` lane
 * event and a human_required supervisor-inbox card — raised ONCE — for an active
 * unbound lane, and NOTHING for a healthy bound lane.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-session-binding-'));
const WS_TOKEN = 'operator-ws-token-binding-0123456789abcdef';
writeFileSync(join(dataDir, 'ws-token'), `${WS_TOKEN}\n`, 'utf-8');
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const heartbeat = await import('@/app/api/lanes/[id]/heartbeat/route');
const laneEvents = await import('@/app/api/lanes/[id]/events/route');
const { createLane, setLaneStatus, getLaneEvents } = await import('@/lib/lane/registry');
const { listRoleRoutingReceipts } = await import('@/lib/operator/role-routing-ledger');
const { listInboxItems } = await import('@/lib/supervisor/inbox');

// Unique repo + packet per lane so the process-global inbox (deduped on
// repo+packet+kind) stays isolated between tests.
function makeActiveLane(sessionKey: string | null) {
  const uniq = Math.random().toString(36).slice(2, 10);
  const lane = createLane({
    repoPath: `/tmp/repo-binding-${uniq}`,
    branch: 'issue/y',
    runtime: 'codex',
    label: 'binding test',
    packetId: `pkt-binding-${uniq}`,
    ...(sessionKey ? { sessionKey } : {}),
  });
  setLaneStatus(lane.id, 'running', 'system', 'test-active');
  return lane;
}

function heartbeatReq(laneId: string): NextRequest {
  return new NextRequest(`http://localhost:3001/api/lanes/${laneId}/heartbeat`, {
    method: 'POST',
    headers: { host: 'localhost:3001', authorization: `Bearer ${WS_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ heartbeatAt: Date.now() }),
  });
}

function progressReq(laneId: string): NextRequest {
  return new NextRequest(`http://localhost:3001/api/lanes/${laneId}/events`, {
    method: 'POST',
    headers: { host: 'localhost:3001', authorization: `Bearer ${WS_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ verb: 'agent_report', event: 'progress', message: 'still working' }),
  });
}

function faultEvents(laneId: string) {
  return getLaneEvents(laneId, 200).filter((event) => (event.verb as string) === 'no_session_binding');
}

function faultCards(repoPath: string) {
  return listInboxItems({ includeAllProjects: true })
    .filter((item) => item.kind === 'no_session_binding' && item.repoPath === repoPath);
}

describe('session-binding fault — through the real heartbeat route', () => {
  it('an active, UNBOUND lane heartbeating raises a no_session_binding event + human_required card', async () => {
    const lane = makeActiveLane(null);
    const res = await heartbeat.POST(heartbeatReq(lane.id), { params: Promise.resolve({ id: lane.id }) });
    expect(res.status).toBe(200);

    expect(faultEvents(lane.id)).toHaveLength(1);
    const cards = faultCards(lane.repoPath);
    expect(cards).toHaveLength(1);
    expect(cards[0].status).toBe('human_required');
    expect(cards[0].packetId).toBe(lane.packetId);
  });

  it('is raised ONCE — a second heartbeat does not duplicate the event or card', async () => {
    const lane = makeActiveLane(null);
    await heartbeat.POST(heartbeatReq(lane.id), { params: Promise.resolve({ id: lane.id }) });
    await heartbeat.POST(heartbeatReq(lane.id), { params: Promise.resolve({ id: lane.id }) });

    expect(faultEvents(lane.id)).toHaveLength(1);
    expect(faultCards(lane.repoPath)).toHaveLength(1);
  });

  it('a healthy BOUND lane heartbeating raises NOTHING', async () => {
    const lane = makeActiveLane('codex-owned:bound-worker');
    const res = await heartbeat.POST(heartbeatReq(lane.id), { params: Promise.resolve({ id: lane.id }) });
    expect(res.status).toBe(200);

    expect(faultEvents(lane.id)).toHaveLength(0);
    expect(faultCards(lane.repoPath).some((card) => card.packetId === lane.packetId)).toBe(false);
    expect(listRoleRoutingReceipts({ repoPath: lane.repoPath })).toEqual([]);
  });
});

describe('session-binding fault — through the real progress-report route', () => {
  it('an active, UNBOUND lane posting a progress report raises the fault', async () => {
    const lane = makeActiveLane(null);
    const res = await laneEvents.POST(progressReq(lane.id), { params: Promise.resolve({ id: lane.id }) });
    expect(res.status).toBe(200);

    expect(faultEvents(lane.id)).toHaveLength(1);
    expect(faultCards(lane.repoPath).some((card) => card.packetId === lane.packetId)).toBe(true);
  });
});
