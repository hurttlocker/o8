/**
 * Principal capability matrix, driven through the REAL route handlers (RF-1).
 *
 * WHY THIS EXISTS — the "green tests encode the premise" gap, incident-proven.
 * The unit test src/lib/auth/principal.test.ts calls resolveRequestPrincipal()
 * with hand-built args and proves the classifier works IN ISOLATION. That is
 * exactly the premise-encoding anti-pattern: it never proves a governance route
 * actually CALLS the resolver on the path a worker takes. This suite imports each
 * mutating control-plane route module and invokes its handler with a constructed
 * Request that carries (or lacks) the local-worker token — so the assertion is
 * "the real endpoint denies the worker", not "the guard function returns 'worker'".
 *
 * Capability matrix asserted (RF-1 §1.3), per principal:
 *   - operator (ws-token bearer)             → allowed / reaches real logic
 *   - worker   (local-worker token)          → 403 (or governance card), never mutates
 *   - unauthenticated remote (LAN, no token) → 401 at the real entry point
 *
 * The worker-token file + ws-token file are written to a temp data dir BEFORE any
 * import, because worker-token.ts and the DB resolve their dir at module load.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';

// Realtime publisher fans out over WS + touches the network; stub it so the
// approvals handler runs its GOVERNANCE logic without side effects.
vi.mock('@/lib/realtime/publisher', () => ({
  publishRealtimeMutation: vi.fn(async () => {}),
}));

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-principal-authz-'));
const WORKER_TOKEN = 'local-worker-token-cafebabe0123456789abcdef01';
const WS_TOKEN = 'operator-ws-token-0123456789abcdefaaaa';
// An enrolled per-device bearer (managed remote access). The middleware + steer
// route resolve it against the registry's derived active-token-hash file.
const DEVICE_TOKEN = 'enrolled-device-token-cafef00d0123456789abcd';
writeFileSync(join(dataDir, 'worker-token'), `${WORKER_TOKEN}\n`, 'utf-8');
writeFileSync(join(dataDir, 'ws-token'), `${WS_TOKEN}\n`, 'utf-8');
writeFileSync(
  join(dataDir, 'mobile-device-tokens'),
  `${createHash('sha256').update(DEVICE_TOKEN).digest('hex')}\n`,
  'utf-8',
);
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

// Dynamic imports — must resolve the data dir set above.
const approvals = await import('@/app/api/panel/approvals/route');
const steer = await import('@/app/api/orchestrator/steer-packet/route');
const reset = await import('@/app/api/orchestrator/reset-packet/route');
const rerun = await import('@/app/api/orchestrator/rerun-with-feedback/route');
const sessionRules = await import('@/app/api/orchestrator/session-rules/route');
const merge = await import('@/app/api/orchestrator/merge/route');
const devServer = await import('@/app/api/panel/dev-server/route');
const fileIo = await import('@/app/api/panel/file-io/route');
const laneEvents = await import('@/app/api/lanes/[id]/events/route');
const { createTestApproval, getApproval } = await import('@/lib/approvals/store');
const { panelGateMiddleware } = await import('@/middleware');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { mintPacketWorkerToken } = await import('@/lib/auth/packet-worker-token');

type Principal = 'operator' | 'worker';

/** A loopback request (so in-handler requirePanelAuth passes) carrying the
 *  worker token when principal='worker'. This is how a dispatched worker's `o8`
 *  CLI actually calls the loopback API. */
function req(
  url: string,
  { principal, method = 'POST', body, workerPacketId, workerToken }: {
    principal: Principal;
    method?: string;
    body?: unknown;
    workerPacketId?: string;
    workerToken?: string;
  },
): NextRequest {
  const headers: Record<string, string> = { host: 'localhost:3001' };
  if (principal === 'worker') {
    headers.authorization = `Bearer ${workerToken ?? WORKER_TOKEN}`;
    if (workerPacketId) headers['x-o8-worker-packet-id'] = workerPacketId;
  } else {
    headers.authorization = `Bearer ${WS_TOKEN}`;
  }
  return new NextRequest(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function packetFixture(overrides: Partial<OrchestratorPacket> = {}): OrchestratorPacket {
  return {
    id: 'pkt-authz-session-rules',
    referenceLabel: 'PKT-AUTHZ',
    title: 'authz packet',
    summary: 'test packet',
    workspaceTargetPath: null,
    branchTarget: 'issue/authz',
    runtime: 'codex',
    dependencyLabels: [],
    dependencyPacketIds: [],
    queueState: 'queued',
    releaseState: 'pending',
    status: 'running',
    blockedReason: null,
    lastEventAt: null,
    lastEventLabel: null,
    archivedAt: null,
    review: null,
    lane: null,
    orchestratorThreadId: null,
    ...overrides,
  };
}

function writeMissionWithPackets(packets: OrchestratorPacket[]): OrchestratorMissionState {
  return writeOrchestratorControlPlaneState({
    ...createEmptyOrchestratorMissionState(),
    missionId: 'mission-principal-authz',
    packets,
  });
}

/** A genuine off-host LAN request with no credential — the unauthenticated
 *  remote principal, denied at the middleware entry point. */
function lanReq(url: string, method = 'POST'): NextRequest {
  return new NextRequest(url.replace('localhost', '192.168.1.50'), {
    method,
    headers: { host: '192.168.1.50:3001' },
  });
}

function anonymousLoopbackReq(url: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: { host: 'localhost:3001' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('principal-authz — approvals resolve (CRIT-1: a worker cannot self-approve)', () => {
  const url = 'http://localhost:3001/api/panel/approvals';

  it('WORKER token → 403, and the approval stays PENDING (no state transition)', async () => {
    const approval = createTestApproval('sess:crit1-worker');
    const res = await approvals.POST(req(url, { principal: 'worker', body: { action: 'approve', id: approval.id } }));
    expect(res.status).toBe(403);
    // Prove the real side effect did NOT happen — the card is untouched.
    expect(getApproval(approval.id)?.status).toBe('pending');
  });

  it('omitting the worker token stays ANONYMOUS and cannot self-approve', async () => {
    const approval = createTestApproval('sess:crit1-omitted-token');
    const res = await approvals.POST(anonymousLoopbackReq(url, { action: 'approve', id: approval.id }));
    expect(res.status).toBe(403);
    expect(getApproval(approval.id)?.status).toBe('pending');
  });

  it('OPERATOR ws-token → resolves the SAME card to approved', async () => {
    const approval = createTestApproval('sess:crit1-operator');
    const res = await approvals.POST(req(url, { principal: 'operator', body: { action: 'approve', id: approval.id } }));
    expect(res.status).toBe(200);
    expect(getApproval(approval.id)?.status).toBe('approved');
  });

  it('unauthenticated REMOTE → denied at the middleware entry point (401)', () => {
    // /api/panel/approvals has no in-handler auth; the middleware IS its gate.
    expect(panelGateMiddleware(lanReq(url)).status).toBe(401);
  });
});

// Control-plane verbs that reject a worker outright (HIGH-4). For the operator
// principal we assert the request is NOT rejected as a worker (it reaches real
// logic and fails later on the missing packet — a 4xx/5xx that is NOT 403),
// which proves the principal gate distinguishes without needing a live packet.
describe('principal-authz — packet control verbs reject worker principals (HIGH-4)', () => {
  const cases: Array<{ name: string; url: string; POST: (r: NextRequest) => Promise<Response>; body: unknown }> = [
    { name: 'steer-packet', url: 'http://localhost:3001/api/orchestrator/steer-packet', POST: steer.POST, body: { packetId: 'pkt-x', message: 'go', idempotencyKey: 'authz-steer-1' } },
    { name: 'reset-packet', url: 'http://localhost:3001/api/orchestrator/reset-packet', POST: reset.POST, body: { packetId: 'pkt-x' } },
    { name: 'rerun-with-feedback', url: 'http://localhost:3001/api/orchestrator/rerun-with-feedback', POST: rerun.POST, body: { packetId: 'pkt-x', feedback: 'redo', idempotencyKey: 'authz-rerun-1' } },
  ];

  for (const c of cases) {
    it(`${c.name}: WORKER → 403`, async () => {
      const res = await c.POST(req(c.url, { principal: 'worker', body: c.body }));
      expect(res.status).toBe(403);
    });

    it(`${c.name}: OPERATOR → NOT 403 (passes the principal gate, reaches real logic)`, async () => {
      const res = await c.POST(req(c.url, { principal: 'operator', body: c.body }));
      expect(res.status).not.toBe(403);
      expect(res.status).not.toBe(401);
    });

    it(`${c.name}: unauthenticated REMOTE → 401 (in-handler requirePanelAuth)`, async () => {
      const res = await c.POST(lanReq(c.url));
      expect(res.status).toBe(401);
    });
  }
});

describe('principal-authz — worker credentials are bound to their persisted packet owner (#1644)', () => {
  const url = 'http://localhost:3001/api/orchestrator/merge';

  it('refuses packet B, accepts packet A, and leaves operator context unaffected through the real merge route', async () => {
    const { createLane } = await import('@/lib/lane/registry');
    const packetA = `pkt-authz-owner-a-${Date.now()}`;
    const packetB = `pkt-authz-owner-b-${Date.now()}`;
    createLane({
      label: 'packet ownership A',
      repoPath: '/tmp/authz-packet-owner-a',
      branch: `agent/${packetA}`,
      baseBranch: 'main',
      runtime: 'codex',
      packetId: packetA,
    });
    createLane({
      label: 'packet ownership B',
      repoPath: '/tmp/authz-packet-owner-b',
      branch: `agent/${packetB}`,
      baseBranch: 'main',
      runtime: 'codex',
      packetId: packetB,
    });
    const packetAToken = mintPacketWorkerToken(packetA);

    const mismatch = await merge.POST(req(url, {
      principal: 'worker',
      workerToken: packetAToken,
      body: { packetId: packetB },
    }));
    expect(mismatch.status).toBe(403);
    expect(await mismatch.json()).toMatchObject({
      ok: false,
      error: { code: 'worker_packet_mismatch' },
    });

    const owned = await merge.POST(req(url, {
      principal: 'worker',
      workerToken: packetAToken,
      body: { packetId: packetA },
    }));
    expect(owned.status).toBe(200);
    expect(await owned.json()).toMatchObject({
      ok: true,
      result: { merged: false, status: 'pending_operator_approval' },
    });

    const operator = await merge.POST(req(url, {
      principal: 'operator',
      body: { packetId: packetB, requestedByWorker: true },
    }));
    expect(operator.status).toBe(200);
  });
});

// Managed remote access (#relay): steer-packet is the ONE control verb the
// operator's phone may drive. It must accept an enrolled per-device bearer while
// still rejecting a worker — driven through the REAL route handler, because the
// route replaced requirePanelAuth with a principal gate and the relay connector
// forwards the device bearer with a NON-loopback client-addr (never loopback-
// trusted). The premise-encoding trap here would be testing resolveRequestPrincipal
// in isolation; instead we invoke steer.POST with the device credential.
describe('principal-authz — steer-packet accepts an enrolled mobile device (managed relay)', () => {
  const url = 'http://localhost:3001/api/orchestrator/steer-packet';

  function deviceReq(body: unknown): NextRequest {
    return new NextRequest(url, {
      method: 'POST',
      headers: { host: 'localhost:3001', authorization: `Bearer ${DEVICE_TOKEN}` },
      body: JSON.stringify(body),
    });
  }

  it('DEVICE token → NOT 403 and NOT 401 (passes the principal gate, reaches real logic)', async () => {
    const res = await steer.POST(deviceReq({
      packetId: 'pkt-does-not-exist',
      message: 'go',
      idempotencyKey: 'device-authz-steer-1',
    }));
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(401);
  });

  it('a device is NOT a worker: the worker is still 403 on the same verb', async () => {
    const res = await steer.POST(req(url, { principal: 'worker', body: { packetId: 'pkt-x', message: 'go' } }));
    expect(res.status).toBe(403);
  });

  it('an unknown/garbage bearer stays anonymous → 401 (fail-closed)', async () => {
    const res = await steer.POST(new NextRequest(url, {
      method: 'POST',
      headers: { host: 'localhost:3001', authorization: 'Bearer not-an-enrolled-device-tokenaaaaaaaa' },
      body: JSON.stringify({ packetId: 'pkt-x', message: 'go' }),
    }));
    expect(res.status).toBe(401);
  });
});

describe('principal-authz — session rules writes are operator-only (#1329 HIGH-4)', () => {
  const url = 'http://localhost:3001/api/orchestrator/session-rules';

  it('POST: WORKER → 403; OPERATOR → 200 and the rule is persisted', async () => {
    const workerRes = await sessionRules.POST(req(url, { principal: 'worker', body: { threadId: 't-1', text: 'no shortcuts' } }));
    expect(workerRes.status).toBe(403);

    const opRes = await sessionRules.POST(req(url, { principal: 'operator', body: { threadId: 't-1', text: 'no shortcuts' } }));
    expect(opRes.status).toBe(200);
    const json = await opRes.json();
    // operatorSuccess wraps the payload as { ok, result }.
    expect(json.result?.rule?.text).toBe('no shortcuts');
  });

  it('DELETE: WORKER → 403 (a worker may READ the rules that govern it, never edit)', async () => {
    const res = await sessionRules.DELETE(req(`${url}?id=some-rule`, { principal: 'worker', method: 'DELETE' }));
    expect(res.status).toBe(403);
  });

  it('GET: WORKER → 200 only for the thread that dispatched its packet', async () => {
    const packetId = 'pkt-authz-owned-thread';
    writeMissionWithPackets([
      packetFixture({ id: packetId, orchestratorThreadId: 't-owned' }),
    ]);
    const res = await sessionRules.GET(req(`${url}?threadId=t-owned`, {
      principal: 'worker',
      method: 'GET',
      workerPacketId: packetId,
      workerToken: mintPacketWorkerToken(packetId),
    }));
    expect(res.status).toBe(200);
  });

  it('GET: WORKER naming another thread → 403', async () => {
    const packetId = 'pkt-authz-other-thread';
    writeMissionWithPackets([
      packetFixture({ id: packetId, orchestratorThreadId: 't-owned' }),
    ]);
    const res = await sessionRules.GET(req(`${url}?threadId=t-stolen`, {
      principal: 'worker',
      method: 'GET',
      workerPacketId: packetId,
      workerToken: mintPacketWorkerToken(packetId),
    }));
    expect(res.status).toBe(403);
  });

  it('GET: WORKER without packet binding → 403', async () => {
    const res = await sessionRules.GET(req(`${url}?threadId=t-1`, { principal: 'worker', method: 'GET' }));
    expect(res.status).toBe(403);
  });
});

describe('principal-authz — shell/RCE primitive is operator-only (HIGH-3 dev-server)', () => {
  const url = 'http://localhost:3001/api/panel/dev-server';

  it('WORKER → 403 before any shell spawn', async () => {
    const res = await devServer.POST(req(url, { principal: 'worker', body: { repoPath: '/tmp', command: 'echo hi' } }));
    expect(res.status).toBe(403);
  });

  it('OPERATOR → NOT 403 (passes the principal gate; missing fields → 400)', async () => {
    const res = await devServer.POST(req(url, { principal: 'operator', body: {} }));
    expect(res.status).toBe(400); // reached real handler: repoPath/command required
  });
});

describe('principal-authz — worker file access is confined to registered repos (HIGH-6)', () => {
  const url = 'http://localhost:3001/api/panel/file-io';

  it('WORKER reading an arbitrary absolute path (/etc/hosts) → 403', async () => {
    const res = await fileIo.GET(req(`${url}?path=${encodeURIComponent('/etc/hosts')}`, { principal: 'worker', method: 'GET' }));
    expect(res.status).toBe(403);
  });

  it('OPERATOR reading the same arbitrary path → NOT 403 (terminal-grade operator tool)', async () => {
    // The file exists on macOS/Linux CI runners; operator passes the worker gate
    // and reads it (200) — the point is it is NOT the worker 403.
    const res = await fileIo.GET(req(`${url}?path=${encodeURIComponent('/etc/hosts')}`, { principal: 'operator', method: 'GET' }));
    expect(res.status).not.toBe(403);
  });
});

// Fail-closed sweep: the absence of a credential must never read as operator.
describe('principal-authz — fail-closed: unknown/absent principal is denied on every mutating verb', () => {
  const mutating = [
    'http://192.168.1.50:3001/api/panel/approvals',
    'http://192.168.1.50:3001/api/orchestrator/steer-packet',
    'http://192.168.1.50:3001/api/orchestrator/reset-packet',
    'http://192.168.1.50:3001/api/orchestrator/rerun-with-feedback',
    'http://192.168.1.50:3001/api/orchestrator/session-rules',
    'http://192.168.1.50:3001/api/orchestrator/merge',
    'http://192.168.1.50:3001/api/panel/dev-server',
    'http://192.168.1.50:3001/api/panel/file-io',
  ];

  it.each(mutating)('LAN POST with no credential is 401 at the gate: %s', (url) => {
    expect(panelGateMiddleware(lanReq(url)).status).toBe(401);
  });
});

describe('principal-authz — worker lane-event reports are accepted (post-CRIT-1 regression)', () => {
  // CRIT-1 made dispatched workers present O8_WORKER_TOKEN instead of the
  // operator ws-token; the lane-events route's in-handler bearer check only
  // compared against the ws-token, silently 401ing every worker
  // `o8 packet report` / huddle post (live-hit 2026-07-03, pkt-1f225562).
  const params = { params: Promise.resolve({ id: 'lane-does-not-exist' }) };

  it('WORKER token → passes the bearer gate (reaches lane lookup, not 401)', async () => {
    const res = await laneEvents.POST(
      req('http://localhost:3001/api/lanes/lane-does-not-exist/events', {
        principal: 'worker',
        body: { verb: 'agent_report', event: 'progress', message: 'x' },
      }),
      params,
    );
    expect(res.status).not.toBe(401);
  });

  it('OPERATOR ws-token → passes the bearer gate too', async () => {
    const headers: Record<string, string> = {
      host: 'localhost:3001',
      authorization: `Bearer ${WS_TOKEN}`,
    };
    const res = await laneEvents.POST(
      new NextRequest('http://localhost:3001/api/lanes/lane-does-not-exist/events', {
        method: 'POST',
        headers,
        body: JSON.stringify({ verb: 'agent_report', event: 'progress', message: 'x' }),
      }),
      params,
    );
    expect(res.status).not.toBe(401);
  });

  it('garbage bearer → still 401', async () => {
    const headers: Record<string, string> = {
      host: 'localhost:3001',
      authorization: 'Bearer not-a-real-token-aaaaaaaaaaaaaaaa',
    };
    const res = await laneEvents.POST(
      new NextRequest('http://localhost:3001/api/lanes/lane-does-not-exist/events', {
        method: 'POST',
        headers,
        body: JSON.stringify({ verb: 'agent_report', event: 'progress', message: 'x' }),
      }),
      params,
    );
    expect(res.status).toBe(401);
  });
});

describe('principal-authz — /api/lanes actor comes from the credential, never the body (#1173 H1)', () => {
  // The hole: dispatch(body) with actor defaulting to trusted 'user' let ANY
  // loopback caller (worker token, tokenless same-origin fetch) self-assert
  // 'user' — which pre-approves merges and skips the governance card. The
  // route now clamps: only the operator credential may act as 'user'; every
  // other principal is forced to 'orchestrator'. Proven through the REAL
  // route handler against a persisted lane, observing the lane event actor.
  it('worker token archiving a lane is recorded as orchestrator even when the body claims user', async () => {
    const lanesRoute = await import('@/app/api/lanes/route');
    const { createLane, getLaneEvents } = await import('@/lib/lane/registry');
    const lane = createLane({
      label: 'authz clamp lane (worker)',
      repoPath: '/tmp/authz-clamp-repo',
      branch: 'agent/authz-clamp-w',
      baseBranch: 'main',
      runtime: 'codex',
      packetId: `pkt-authz-clamp-worker-${Date.now()}`,
    });
    const res = await lanesRoute.POST(req('http://localhost:3001/api/lanes', {
      principal: 'worker',
      workerToken: mintPacketWorkerToken(lane.packetId!),
      body: { verb: 'archive', laneId: lane.id, actor: 'user' },
    }));
    expect(res.status).toBeLessThan(500);
    const events = getLaneEvents(lane.id, 20);
    const archived = events.filter((event) => event.verb === 'status_change')
      .find((event) => (event.payload as { status?: string }).status === 'archived');
    expect(archived).toBeTruthy();
    expect(archived?.actor).toBe('orchestrator');
  });

  it('operator token keeps user-actor semantics', async () => {
    const lanesRoute = await import('@/app/api/lanes/route');
    const { createLane, getLaneEvents } = await import('@/lib/lane/registry');
    const lane = createLane({
      label: 'authz clamp lane (operator)',
      repoPath: '/tmp/authz-clamp-repo',
      branch: 'agent/authz-clamp-o',
      baseBranch: 'main',
      runtime: 'codex',
    });
    const res = await lanesRoute.POST(req('http://localhost:3001/api/lanes', {
      principal: 'operator',
      body: { verb: 'archive', laneId: lane.id },
    }));
    expect(res.status).toBeLessThan(500);
    const events = getLaneEvents(lane.id, 20);
    const archived = events.filter((event) => event.verb === 'status_change')
      .find((event) => (event.payload as { status?: string }).status === 'archived');
    expect(archived).toBeTruthy();
    expect(archived?.actor).toBe('user');
  });

  it('tokenless loopback is clamped to orchestrator (fail-closed for the self-merge class)', async () => {
    const lanesRoute = await import('@/app/api/lanes/route');
    const { createLane, getLaneEvents } = await import('@/lib/lane/registry');
    const lane = createLane({
      label: 'authz clamp lane (anon)',
      repoPath: '/tmp/authz-clamp-repo',
      branch: 'agent/authz-clamp-a',
      baseBranch: 'main',
      runtime: 'codex',
    });
    const res = await lanesRoute.POST(anonymousLoopbackReq('http://localhost:3001/api/lanes', {
      verb: 'archive',
      laneId: lane.id,
      actor: 'user',
    }));
    expect(res.status).toBeLessThan(500);
    const events = getLaneEvents(lane.id, 20);
    const archived = events.filter((event) => event.verb === 'status_change')
      .find((event) => (event.payload as { status?: string }).status === 'archived');
    expect(archived).toBeTruthy();
    expect(archived?.actor).toBe('orchestrator');
  });
});
