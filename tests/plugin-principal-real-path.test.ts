import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const steer = vi.hoisted(() => vi.fn(async () => ({ packetId: 'packet-plugin', laneId: 'lane-plugin', note: 'accepted' })));
// The external worker dispatch is the fake boundary; HTTP auth, durable mission
// lookup, idempotency, and the local audit file below are production paths.
vi.mock('@/lib/orchestrator/operator-mission-service', () => ({ steerPacket: steer }));

import { POST } from '@/app/api/plugins/mcp/route';
import { GET as audit } from '@/app/api/plugins/audit/route';
import { mintPluginToken, resolvePluginToken } from '@/lib/auth/plugin-token';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { getDataDir } from '@/lib/data-dir-migration';
import { readPluginAudit } from '@/lib/mcp/plugin-audit';
import { __resetIdempotencyStoreForTests } from '@/lib/orchestrator/idempotency-store';
import { writeOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import { createEmptyOrchestratorMissionState } from '@/lib/orchestrator/store';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { panelGateMiddleware } from '@/middleware';

function token(scopes = ['o8:read', 'o8:follow-up']) {
  return mintPluginToken({ machineId: 'machine-plugin', clientId: 'client-plugin', scopes });
}
function request(name: string, args: Record<string, unknown>, bearer = token(), path = '/api/plugins/mcp') {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
}
function seed(overrides: Partial<OrchestratorPacket> = {}) {
  const packet: OrchestratorPacket = {
    id: 'packet-plugin', referenceLabel: 'P1', title: 'Check a task', summary: 'In progress',
    workspaceTargetPath: null, branchTarget: 'codex/test', runtime: 'codex',
    dependencyLabels: [], dependencyPacketIds: [], queueState: 'queued', releaseState: 'pending', status: 'running',
    ...overrides,
  };
  writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(), missionId: 'mission-plugin', repoPath: '/test/project', packets: [packet] });
}
const selected = { machineId: 'machine-plugin', missionId: 'mission-plugin', packetId: 'packet-plugin' };

beforeEach(() => { steer.mockClear(); __resetIdempotencyStoreForTests(); seed(); });

describe('plugin principal through the real API and persisted state', () => {
  it('reads bounded status and persists a plugin-attributed audit without payloads', async () => {
    const req = request('o8_attention', { machineId: 'machine-plugin' });
    expect(resolveRequestPrincipal(req)).toBe('plugin');
    expect(panelGateMiddleware(req).status).toBe(200);
    const response = await POST(req);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result.structuredContent.tasks[0]).toMatchObject({ missionId: 'mission-plugin', packetId: 'packet-plugin', project: 'project' });
    expect(JSON.stringify(body)).not.toContain('/test/project');
    const entries = readPluginAudit();
    expect(entries.at(-1)).toMatchObject({ actor: 'plugin', surface: 'chatgpt', clientId: 'client-plugin', phase: 'finished', outcome: 'success' });
    expect(statSync(join(getDataDir(), 'plugin-audit.jsonl')).mode & 0o777).toBe(0o600);
  });

  it('deduplicates an exact follow-up across a new credential and rejects key reuse with new content', async () => {
    const args = { ...selected, message: 'Please check the tests.', idempotencyKey: 'exact-retry' };
    expect((await POST(request('o8_follow_up', args))).status).toBe(200);
    const second = await POST(request('o8_follow_up', args, token()));
    expect((await second.json()).result.structuredContent).toMatchObject({ accepted: true, completed: false, replayed: true });
    const conflict = await POST(request('o8_follow_up', { ...args, message: 'A different task.' }));
    expect((await conflict.json()).result.structuredContent.code).toBe('idempotency_key_conflict');
    expect(steer).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(getDataDir(), 'plugin-audit.jsonl'), 'utf8')).not.toContain(args.message);
  });

  it('refuses approval, merge, unrestricted MCP, and every other route even when public', async () => {
    for (const path of ['/api/panel/approvals', '/api/worktrees/merge', '/api/mcp', '/api/mobile/enroll', '/api/plugins/audit', '/api/plugins/mcp/extra']) {
      expect(panelGateMiddleware(request('approve', {}, token(), path)).status).toBe(403);
    }
    for (const name of ['approve_and_merge', 'o8_exec', 'approve']) {
      expect((await POST(request(name, selected))).status).toBe(403);
    }
    expect((await audit(request('unused', {}, token()))).status).toBe(403);
    expect(steer).not.toHaveBeenCalled();
  });

  it('enforces granted scope, machine binding, and stopped-task holds', async () => {
    const args = { ...selected, message: 'Keep working.', idempotencyKey: 'denied' };
    expect((await POST(request('o8_follow_up', args, token(['o8:read'])))).status).toBe(403);
    expect((await POST(request('o8_result', { ...selected, machineId: 'other-machine' }))).status).toBe(403);
    seed({ operatorStopped: true });
    expect((await (await POST(request('o8_follow_up', args))).json()).result.structuredContent.code).toBe('task_unavailable');
    expect(steer).not.toHaveBeenCalled();
  });

  it('excludes old released work, puts blockers first, and exposes further pages', async () => {
    seed();
    const state = createEmptyOrchestratorMissionState();
    const packet = {
      id: 'base', referenceLabel: 'P1', title: 'A'.repeat(160), summary: 'B'.repeat(160),
      workspaceTargetPath: null, branchTarget: 'codex/test', runtime: 'codex',
      dependencyLabels: [], dependencyPacketIds: [], queueState: 'queued', releaseState: 'pending', status: 'running',
    } as OrchestratorPacket;
    const packets = [
      ...Array.from({ length: 25 }, (_, index) => ({ ...packet, id: `old-${index}`, releaseState: 'released' as const })),
      ...Array.from({ length: 22 }, (_, index) => ({ ...packet, id: `live-${index}` })),
      { ...packet, id: 'blocker', status: 'blocked' as const },
    ];
    writeOrchestratorControlPlaneState({ ...state, missionId: 'mission-plugin', packets });
    const response = await POST(request('o8_attention', { machineId: 'machine-plugin' }));
    const body = await response.json();
    expect(body.result.structuredContent.tasks[0].packetId).toBe('blocker');
    expect(body.result.structuredContent).toMatchObject({ totalTasks: 23, nextCursor: '20' });
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(65_536);
    const next = await POST(request('o8_attention', { machineId: 'machine-plugin', cursor: '20' }));
    expect((await next.json()).result.structuredContent.tasks).toHaveLength(3);
  });

  it('rejects forged and expired credentials at both the gate and handler', async () => {
    const issued = token();
    const expired = mintPluginToken({ machineId: 'machine-plugin', clientId: 'client-plugin', scopes: ['o8:read'] }, { now: Date.now() - 61_000 });
    for (const value of [`${issued.slice(0, -5)}abcde`, expired, 'operator-not-a-plugin']) {
      expect(resolvePluginToken(value)).toBeNull();
      expect(panelGateMiddleware(request('o8_attention', {}, value)).status).toBe(401);
      expect((await POST(request('o8_attention', {}, value))).status).toBe(401);
    }
  });
});
