/**
 * #2395 — only operator-authored steers carry operator standing.
 *
 * Real-path doctrine: every steer is sent through the REAL steer-packet route
 * handler with a constructed principal (worker token, operator ws-token), so the
 * persisted `steered_packet` row is the one the route actually writes. The read
 * side goes through the real `buildPacketPrompt` and the real Brain retrieval
 * merge — never the formatter or reader with hand-built corrections.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runPacketSteer } from '../cli/src/commands/packet/recover';

import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const h = vi.hoisted(() => ({ perform: vi.fn() }));
const originalStdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
const originalStdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

vi.mock('@/lib/runtime/actions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runtime/actions')>();
  return { ...actual, performRuntimeAction: h.perform };
});
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}) }));
vi.mock('@/lib/command-center/snapshot', () => ({ invalidateCommandCenterSnapshotCaches: vi.fn() }));
vi.mock('@/lib/mobile/inbox', () => ({ invalidateInboxCache: vi.fn() }));

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-steer-standing-'));
const repoPath = mkdtempSync(join(os.tmpdir(), 'o8-steer-standing-repo-'));
const OPERATOR_TOKEN = 'operator-steer-standing-0123456789abcdef';
const DEVICE_TOKEN = 'fixture-device-steering-2426';
writeFileSync(join(dataDir, 'mobile-device-tokens'), createHash('sha256').update(DEVICE_TOKEN).digest('hex') + '\n');
const WORKER_TOKEN = 'local-worker-steer-standing-cafebabe012345';
writeFileSync(join(dataDir, 'ws-token'), `${OPERATOR_TOKEN}\n`, 'utf8');
writeFileSync(join(dataDir, 'worker-token'), `${WORKER_TOKEN}\n`, 'utf8');
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const steerRoute = await import('@/app/api/orchestrator/steer-packet/route');
const idempotency = await import('@/lib/orchestrator/idempotency-store');
const { closeDb, getSqlite } = await import('@/lib/db');
const { createLane } = await import('@/lib/lane/registry');
const { mintPacketWorkerToken } = await import('@/lib/auth/packet-worker-token');
const { buildPacketPrompt } = await import('@/lib/orchestrator/packet-prompt');
const { rowAuthority } = await import('@/lib/cortex/qa/citations');

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

beforeEach(() => {
  h.perform.mockReset();
  idempotency.__resetIdempotencyStoreForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const [stream, descriptor] of [[process.stdin, originalStdinTTY], [process.stdout, originalStdoutTTY]] as const) {
    if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor);
    else Reflect.deleteProperty(stream, 'isTTY');
  }
});

function packetFixture(id: string): OrchestratorPacket {
  return {
    id,
    workspaceTargetPath: null,
    branchTarget: null,
    referenceLabel: 'PKT-2395',
    title: 'fix the ledger migration',
    summary: 'Fix the migration.',
    status: 'draft',
    queueState: 'queued',
    releaseState: 'pending',
    blockedReason: null,
    lane: null,
    review: null,
    runtime: 'codex',
    dependencyPacketIds: [],
    dependencyLabels: [],
    attemptCount: 1,
    lastEventAt: '2026-09-17T00:00:00.000Z',
    lastEventLabel: 'rerun',
    recoveryCount: 0,
    typecheckAutoRetries: 0,
    orchestratorThreadId: null,
  } as unknown as OrchestratorPacket;
}

function steerableLane(packetId: string) {
  // A non-codex session key skips the owned-session startup probe.
  const lane = createLane({
    repoPath,
    branch: `o8/${packetId}`,
    runtime: 'codex',
    packetId,
    sessionKey: `test-runtime:${packetId}`,
  });
  h.perform.mockResolvedValue({
    ok: true,
    action: 'steer',
    surfaceId: lane.sessionKey,
    sessionKey: lane.sessionKey,
    runtime: lane.runtime,
    status: 'sent',
    note: 'steered',
  });
  return lane;
}

function steerRequest(bearer: string, body: Record<string, unknown>, workerPacketId?: string) {
  const headers: Record<string, string> = {
    host: 'localhost:3001',
    authorization: `Bearer ${bearer}`,
    'content-type': 'application/json',
  };
  if (workerPacketId) headers['x-o8-worker-packet-id'] = workerPacketId;
  return new NextRequest('http://localhost:3001/api/orchestrator/steer-packet', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function steerEventCount(laneId: string): number {
  const row = getSqlite().prepare(
    "SELECT COUNT(*) AS count FROM lane_events WHERE lane_id = ? AND verb = 'steered_packet'",
  ).get(laneId) as { count: number };
  return row.count;
}

function steerEventSource(laneId: string): string {
  const row = getSqlite().prepare(
    "SELECT payload_json FROM lane_events WHERE lane_id = ? AND verb = 'steered_packet'",
  ).get(laneId) as { payload_json: string };
  return JSON.parse(row.payload_json).source;
}

describe('#2395 steer route — a worker cannot author a correction', () => {
  it('legacy worker token → 403, no steer row, nothing in the next prompt', async () => {
    const packetId = 'pkt-2395-worker-legacy';
    const lane = steerableLane(packetId);
    const message = 'Worker-authored steer that must never become a correction';

    const res = await steerRoute.POST(steerRequest(WORKER_TOKEN, {
      packetId,
      message,
      source: 'operator',
      idempotencyKey: 'steer-2395-worker-legacy',
    }));
    expect(res.status).toBe(403);
    expect(h.perform).not.toHaveBeenCalled();
    expect(steerEventCount(lane.id)).toBe(0);

    const prompt = await buildPacketPrompt(packetFixture(packetId), []);
    expect(prompt).not.toContain(message);
    expect(prompt).not.toContain('Operator corrections for this packet');
    expect(prompt).not.toContain('Machine steering for this packet');
  });

  it('packet-bound worker token steering its own packet → 403, no steer row', async () => {
    const packetId = 'pkt-2395-worker-bound';
    const lane = steerableLane(packetId);
    const message = 'Packet-bound worker steer claiming operator standing';

    const res = await steerRoute.POST(steerRequest(mintPacketWorkerToken(packetId), {
      packetId,
      message,
      source: 'operator',
      idempotencyKey: 'steer-2395-worker-bound',
    }, packetId));
    expect(res.status).toBe(403);
    expect(steerEventCount(lane.id)).toBe(0);

    const prompt = await buildPacketPrompt(packetFixture(packetId), []);
    expect(prompt).not.toContain(message);
  });
});

describe('#2395 steer route — operator standing versus machine steering', () => {
  const OPERATOR_MESSAGE = 'Keep the ledger migration additive and never rename the column';
  const MACHINE_MESSAGE = 'Typecheck failed in the ledger migration, fix the column type';

  it('an operator steer through the route surfaces as an operator correction', async () => {
    const packetId = 'pkt-2395-operator';
    const lane = steerableLane(packetId);

    const res = await steerRoute.POST(steerRequest(OPERATOR_TOKEN, {
      packetId,
      message: OPERATOR_MESSAGE,
      source: 'operator',
      idempotencyKey: 'steer-2395-operator',
    }));
    expect(res.status).toBe(200);
    expect(steerEventCount(lane.id)).toBe(1);

    const prompt = await buildPacketPrompt(packetFixture(packetId), []);
    expect(prompt).toContain('Operator corrections for this packet');
    expect(prompt).toContain(`[steered `);
    expect(prompt).toContain(OPERATOR_MESSAGE);
    expect(prompt).not.toContain('Machine steering for this packet');
  });

  it('an orchestrator steer (the MCP steer_packet body) surfaces only as machine steering', async () => {
    const packetId = 'pkt-2395-machine';
    const lane = steerableLane(packetId);

    const res = await steerRoute.POST(steerRequest(OPERATOR_TOKEN, {
      packetId,
      message: MACHINE_MESSAGE,
      source: 'orchestrator',
      idempotencyKey: 'steer-2395-machine',
    }));
    expect(res.status).toBe(200);
    expect(steerEventCount(lane.id)).toBe(1);

    const prompt = await buildPacketPrompt(packetFixture(packetId), []);
    expect(prompt).not.toContain('Operator corrections for this packet');
    expect(prompt).toContain('Machine steering for this packet');
    expect(prompt).toContain(`[machine steer via orchestrator `);
    expect(prompt).toContain(MACHINE_MESSAGE);
  });

  it('the Brain cites the operator steer at operator authority and the machine steer lower', async () => {
    const { retrieveAll, unionMerge } = await import('@/lib/cortex/qa/retrieve');
    const results = await retrieveAll({
      question: 'why was the ledger migration steered?',
      repoPath,
    });
    const merged = unionMerge(results).filter((row) => row.citation.kind === 'correction');
    const operatorRow = merged.find((row) => row.fields.body === OPERATOR_MESSAGE);
    const machineRow = merged.find((row) => row.fields.body === MACHINE_MESSAGE);

    expect(operatorRow?.fields.standing).toBe('operator');
    expect(operatorRow?.citation.title).toMatch(/^Operator steered:/);
    expect(rowAuthority(operatorRow!)).toBe(0.95);

    expect(machineRow?.fields.standing).toBe('machine');
    expect(machineRow?.citation.title).toMatch(/^Machine steer via orchestrator:/);
    expect(rowAuthority(machineRow!)).toBeLessThanOrEqual(0.6);
    expect(merged.indexOf(operatorRow!)).toBeLessThan(merged.indexOf(machineRow!));
  });
});

describe('#2426 caller source survives the public entry points', () => {
  it('an operator request without source persists operator standing through the prompt', async () => {
    const packetId = 'pkt-2426-implicit-operator';
    const lane = steerableLane(packetId);
    const message = 'Human correction from a source-less client';
    const res = await steerRoute.POST(steerRequest(OPERATOR_TOKEN, {
      packetId, message, idempotencyKey: 'implicit-operator',
    }));
    expect(res.status).toBe(200);
    expect(steerEventCount(lane.id)).toBe(1);
    const prompt = await buildPacketPrompt(packetFixture(packetId), []);
    expect(prompt).toContain('Operator corrections for this packet');
    expect(prompt).toContain(message);
    expect(prompt).not.toContain('Machine steering for this packet');
  });

  it('a source-less agent tool remains machine steering under the operator credential', async () => {
    const packetId = 'pkt-2426-tool-default';
    steerableLane(packetId);
    const request = steerRequest(OPERATOR_TOKEN, {
      packetId, message: 'Machine tool correction', idempotencyKey: 'tool-default',
    });
    request.headers.set('x-o8-agent-tool', '1');
    expect((await steerRoute.POST(request)).status).toBe(200);
    const prompt = await buildPacketPrompt(packetFixture(packetId), []);
    expect(prompt).toContain('Machine steering for this packet');
    expect(prompt).not.toContain('Operator corrections for this packet');
  });

  it.each([
    ['no-tty', undefined, undefined, undefined, 'orchestrator'],
    ['piped', false, false, undefined, 'orchestrator'],
    ['input-only', true, false, undefined, 'orchestrator'],
    ['output-only', false, true, undefined, 'orchestrator'],
    ['human', true, true, undefined, 'operator'],
    ...['O8_WORKER_PACKET_ID', 'O8_OWNED_RUN_MARKER', 'CODEX_SESSION_ID', 'CODEX_THREAD_ID',
      'CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'AI_AGENT'].map(marker => [marker, true, true, marker, 'orchestrator'] as const),
  ] as const)('the actual %s CLI steer reaches the route with the right standing', async (caller, stdinTTY, stdoutTTY, marker, source) => {
    const packetId = `pkt-2426-cli-${caller}`;
    const lane = steerableLane(packetId);
    for (const key of ['O8_WORKER_TOKEN', 'O8_WORKER_PACKET_ID', 'O8_OWNED_RUN_MARKER',
      'CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'AI_AGENT']) {
      vi.stubEnv(key, '');
    }
    vi.stubEnv('O8_API_TOKEN', OPERATOR_TOKEN);
    if (marker) vi.stubEnv(marker, 'fixture-agent-session');
    Object.defineProperty(process.stdin, 'isTTY', { value: stdinTTY, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: stdoutTTY, configurable: true });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/lanes') return Response.json({ lanes: [lane] });
      if (url.pathname !== '/api/orchestrator/steer-packet') throw new Error(`Unexpected route ${url.pathname}`);
      return steerRoute.POST(new NextRequest(url, { ...init, signal: init?.signal ?? undefined }));
    });
    expect(await runPacketSteer({ human: false, verbose: false }, [packetId, '--message', 'CLI correction'])).toBe(0);
    expect(steerEventCount(lane.id)).toBe(1);
    expect(steerEventSource(lane.id)).toBe(source);
    const prompt = await buildPacketPrompt(packetFixture(packetId), []);
    expect(prompt).toContain(source === 'operator' ? 'Operator corrections for this packet' : 'Machine steering for this packet');
    expect(prompt).not.toContain(source === 'operator' ? 'Machine steering for this packet' : 'Operator corrections for this packet');
  });
});

describe('#2426 non-operator attribution stays bounded', () => {
  it('a source-less device request retains machine standing', async () => {
    const packetId = 'pkt-2426-device-default';
    steerableLane(packetId);
    const res = await steerRoute.POST(steerRequest(DEVICE_TOKEN, {
      packetId, message: 'Device correction', idempotencyKey: 'device-default',
    }));
    expect(res.status).toBe(200);
    const prompt = await buildPacketPrompt(packetFixture(packetId), []);
    expect(prompt).toContain('Machine steering for this packet');
    expect(prompt).not.toContain('Operator corrections for this packet');
  });

  it('the MCP steer tool does not advertise caller-selected provenance', async () => {
    const { STATUS_TOOLS } = await import('@/lib/mcp/operator-handlers/status');
    const tool = STATUS_TOOLS.find(tool => tool.name === 'steer_packet');
    expect(tool).toBeDefined();
    expect(tool?.inputSchema.properties).not.toHaveProperty('source');
  });

  it.each(['operator', ' Operator ', 'OPERATOR'])('a device cannot claim %s standing', async (source) => {
    const packetId = `pkt-2426-device-${source.trim()}`;
    const lane = steerableLane(packetId);
    const res = await steerRoute.POST(steerRequest(DEVICE_TOKEN, {
      packetId, source, message: 'Device correction', idempotencyKey: `device-${source}`,
    }));
    expect(res.status).toBe(403);
    expect(steerEventCount(lane.id)).toBe(0);
    expect(h.perform).not.toHaveBeenCalled();
  });

  it.each(['operator', ' Operator ', 'OPERATOR', 'orchestrator', undefined, 'invalid'])('the MCP records machine steering even when asked for %s provenance', async (source) => {
    const packetId = `pkt-2426-mcp-${source?.trim() ?? 'omitted'}`;
    const lane = steerableLane(packetId);
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      return steerRoute.POST(new NextRequest(String(input), { ...init, signal: init?.signal ?? undefined }));
    });
    const { handleSteerPacket } = await import('@/lib/mcp/operator-handlers/status');
    const result = await handleSteerPacket({ packetId, message: 'MCP forwarded correction', source });
    expect(result.isError).not.toBe(true);
    expect(steerEventCount(lane.id)).toBe(1);
    expect(steerEventSource(lane.id)).toBe('orchestrator');
    const prompt = await buildPacketPrompt(packetFixture(packetId), []);
    expect(prompt).toContain('Machine steering for this packet');
    expect(prompt).not.toContain('Operator corrections for this packet');
  });
});
