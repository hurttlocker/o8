import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, describe, expect, it } from 'vitest';
import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-mission-funnel-real-path-'));
const ownedRoot = join(dataDir, 'owned-opencode');
const codexOwnedRoot = join(dataDir, 'owned-codex');
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_OWNED_OPENCODE_ROOT = ownedRoot;
process.env.CORTEX_IDE_OWNED_CODEX_ROOT = codexOwnedRoot;

const { createApproval } = await import('@/lib/approvals/store');
const { getSqlite } = await import('@/lib/db');
const { recordMission } = await import('@/lib/db/missions-store');
const {
  appendEvent,
  archiveLane,
  attachSession,
  createLane,
  setLaneStatus,
  updateLane,
} = await import('@/lib/lane/registry');
const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { aggregateMissionCost } = await import('@/lib/orchestrator/cost-aggregator');
const { projectMissionFunnel } = await import('@/lib/orchestrator/mission-funnel');
const { getMissionStatus } = await import('@/lib/orchestrator/operator-mission-service');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const statusRoute = await import('@/app/api/orchestrator/status/route');

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function writeOpencodeTranscript(surfaceId: string, entries: unknown[]) {
  const id = surfaceId.replace(/^opencode-owned:/, '');
  const sessionDir = join(ownedRoot, id);
  const runsDir = join(sessionDir, 'runs');
  const stdoutPath = join(runsDir, 'run.stdout.jsonl');
  const stderrPath = join(runsDir, 'run.stderr.log');
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(stdoutPath, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  writeFileSync(stderrPath, '');
  writeFileSync(join(sessionDir, 'session.json'), `${JSON.stringify({
    surfaceId,
    sessionDir,
    cwd: dataDir,
    repoPath: dataDir,
    title: id,
    createdAt: '2026-08-12T10:00:00.000Z',
    updatedAt: '2026-08-12T10:20:00.000Z',
    latestPrompt: 'test mission funnel',
    latestSummary: 'done',
    model: 'test/model',
    recentRuns: [{
      id: `run-${id}`,
      mode: 'launch',
      prompt: 'test mission funnel',
      startedAt: '2026-08-12T10:00:00.000Z',
      finishedAt: '2026-08-12T10:20:00.000Z',
      pid: 1,
      stdoutPath,
      stderrPath,
      outcome: 'finished',
    }],
  }, null, 2)}\n`);
}

function stampLaneEvents(laneId: string, timestamps: string[]) {
  const rows = getSqlite().prepare(`
    SELECT id FROM lane_events WHERE lane_id = ? ORDER BY rowid ASC
  `).all(laneId) as Array<{ id: string }>;
  expect(rows).toHaveLength(timestamps.length);
  rows.forEach((row, index) => {
    getSqlite().prepare('UPDATE lane_events SET timestamp = ? WHERE id = ?')
      .run(timestamps[index], row.id);
  });
}

function writeCodexIdentitySession(surfaceId: string, identityId: string, configHomeRef: string) {
  const id = surfaceId.replace(/^codex-owned:/, '');
  const sessionDir = join(codexOwnedRoot, id);
  mkdirSync(join(sessionDir, 'runs'), { recursive: true });
  writeFileSync(join(sessionDir, 'session.json'), `${JSON.stringify({
    surfaceId,
    sessionDir,
    cwd: dataDir,
    repoPath: dataDir,
    title: id,
    createdAt: '2026-08-12T10:00:00.000Z',
    updatedAt: '2026-08-12T10:20:00.000Z',
    latestPrompt: 'identity receipt test',
    latestSummary: 'done',
    identity: {
      id: identityId,
      label: 'Private account label',
      configHomeRef,
    },
    recentRuns: [],
  }, null, 2)}\n`);
}

describe('mission funnel persisted status path', () => {
  it('keeps packet identity ambiguous when retry attempts use different identities', async () => {
    const packetId = 'packet-funnel-mixed-identity';
    const firstSession = 'codex-owned:funnel-identity-first';
    const secondSession = 'codex-owned:funnel-identity-second';
    writeCodexIdentitySession(firstSession, 'codex-identity-first', join(dataDir, 'codex-home-first'));
    writeCodexIdentitySession(secondSession, 'codex-identity-second', join(dataDir, 'codex-home-second'));
    const firstLane = createLane({
      repoPath: dataDir,
      branch: 'inline/funnel-identity-first',
      runtime: 'codex',
      packetId,
      sessionKey: firstSession,
    });
    const secondLane = createLane({
      repoPath: dataDir,
      branch: 'inline/funnel-identity-second',
      runtime: 'codex',
      packetId,
      sessionKey: secondSession,
    });
    stampLaneEvents(firstLane.id, ['2026-08-12T10:01:00.000Z']);
    stampLaneEvents(secondLane.id, ['2026-08-12T10:10:00.000Z']);
    const packet: OrchestratorPacket = {
      id: packetId,
      referenceLabel: 'PKT-MIXED-IDENTITY',
      title: 'mixed identity receipt',
      summary: 'mixed identity receipt',
      workspaceTargetPath: dataDir,
      branchTarget: secondLane.branch,
      runtime: 'codex',
      dependencyLabels: [],
      dependencyPacketIds: [],
      queueState: 'queued',
      releaseState: 'pending',
      status: 'running',
      lane: null,
    };

    const receipt = await projectMissionFunnel({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-funnel-mixed-identity',
      repoPath: dataDir,
      runtime: 'codex',
      packets: [packet],
    });

    expect(receipt.packets[0]?.identityId).toBeNull();
    expect(receipt.packets[0]?.attempts.map((attempt) => attempt.identityId)).toEqual([
      'codex-identity-first',
      'codex-identity-second',
    ]);
  });

  it('stops a mission transcript window when the session moves to another mission', async () => {
    const sessionKey = 'opencode-owned:funnel-cross-mission';
    writeOpencodeTranscript(sessionKey, [
      {
        type: 'text',
        timestamp: '2026-08-12T10:04:00.000Z',
        part: { type: 'text', text: 'First mission output' },
      },
      {
        type: 'text',
        timestamp: '2026-08-12T10:14:00.000Z',
        part: { type: 'text', text: 'Second mission output' },
      },
    ]);
    const firstLane = createLane({
      repoPath: dataDir,
      branch: 'inline/funnel-cross-mission-first',
      runtime: 'opencode',
      packetId: 'packet-funnel-cross-mission-first',
      sessionKey,
    });
    const secondLane = createLane({
      repoPath: dataDir,
      branch: 'inline/funnel-cross-mission-second',
      runtime: 'opencode',
      packetId: 'packet-funnel-cross-mission-second',
      sessionKey,
    });
    stampLaneEvents(firstLane.id, ['2026-08-12T10:01:00.000Z']);
    stampLaneEvents(secondLane.id, ['2026-08-12T10:10:00.000Z']);
    const packet: OrchestratorPacket = {
      id: 'packet-funnel-cross-mission-first',
      referenceLabel: 'PKT-CROSS-MISSION-FIRST',
      title: 'first mission',
      summary: 'first mission',
      workspaceTargetPath: dataDir,
      branchTarget: firstLane.branch,
      runtime: 'opencode',
      dependencyLabels: [],
      dependencyPacketIds: [],
      queueState: 'queued',
      releaseState: 'pending',
      status: 'running',
      lane: null,
    };

    const receipt = await projectMissionFunnel({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-funnel-cross-mission-first',
      repoPath: dataDir,
      runtime: 'opencode',
      packets: [packet],
    });

    expect(receipt.packets[0]?.phases.firstOutputAt).toBe('2026-08-12T10:04:00.000Z');
    expect(receipt.packets[0]?.phases.lastOutputAt).toBe('2026-08-12T10:04:00.000Z');
  });

  it('keeps output from every session attached to one lane', async () => {
    const packetId = 'packet-funnel-rebound';
    const firstSession = 'opencode-owned:funnel-rebound-first';
    const secondSession = 'opencode-owned:funnel-rebound-second';
    writeOpencodeTranscript(firstSession, [{
      type: 'text',
      timestamp: '2026-08-12T10:04:00.000Z',
      part: { type: 'text', text: 'First bound session output' },
    }]);
    writeOpencodeTranscript(secondSession, [{
      type: 'text',
      timestamp: '2026-08-12T10:12:00.000Z',
      part: { type: 'text', text: 'Second bound session output' },
    }]);
    const lane = createLane({
      repoPath: dataDir,
      branch: 'inline/funnel-rebound',
      runtime: 'opencode',
      packetId,
    });
    setLaneStatus(lane.id, 'launching', 'system', 'first launch');
    attachSession(lane.id, firstSession, 'system');
    setLaneStatus(lane.id, 'recovering', 'system', 'retry');
    setLaneStatus(lane.id, 'launching', 'system', 'second launch');
    attachSession(lane.id, secondSession, 'system');
    stampLaneEvents(lane.id, [
      '2026-08-12T10:01:00.000Z',
      '2026-08-12T10:02:00.000Z',
      '2026-08-12T10:03:00.000Z',
      '2026-08-12T10:08:00.000Z',
      '2026-08-12T10:09:00.000Z',
      '2026-08-12T10:10:00.000Z',
    ]);
    const earlierApproval = createApproval({
      source: 'runtime',
      runtime: 'opencode',
      agent: 'rebound worker',
      sessionKey: firstSession,
      title: 'Earlier session permission',
      description: 'Permission from the first bound session',
      summary: 'Permission from the first bound session',
      risk: 'medium',
      continuation: {
        kind: 'runtime',
        runtimeId: 'opencode',
        sessionKey: firstSession,
        action: 'resume',
        message: 'continue',
      },
    });
    getSqlite().prepare(`
      UPDATE approvals
         SET status = 'rejected', created_at = ?, updated_at = ?, resolved_at = ?
       WHERE id = ?
    `).run(
      new Date('2026-08-12T10:05:00.000Z').getTime(),
      new Date('2026-08-12T10:06:00.000Z').getTime(),
      new Date('2026-08-12T10:06:00.000Z').getTime(),
      earlierApproval.id,
    );
    const packet: OrchestratorPacket = {
      id: packetId,
      referenceLabel: 'PKT-FUNNEL-REBOUND',
      title: 'rebound funnel receipt',
      summary: 'rebound funnel receipt',
      workspaceTargetPath: dataDir,
      branchTarget: lane.branch,
      runtime: 'opencode',
      dependencyLabels: [],
      dependencyPacketIds: [],
      queueState: 'queued',
      releaseState: 'pending',
      status: 'running',
      lane: null,
    };

    const receipt = await projectMissionFunnel({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-funnel-rebound',
      repoPath: dataDir,
      runtime: 'opencode',
      packets: [packet],
    });

    expect(receipt.packets[0]?.phases.firstOutputAt).toBe('2026-08-12T10:04:00.000Z');
    expect(receipt.packets[0]?.phases.lastOutputAt).toBe('2026-08-12T10:12:00.000Z');
    expect(receipt.packets[0]?.attemptCount).toBe(2);
    expect(receipt.packets[0]?.retryCount).toBe(1);
    expect(receipt.packets[0]?.attempts.map((attempt) => attempt.sessionKey)).toEqual([
      firstSession,
      secondSession,
    ]);
    expect(receipt.packets[0]?.attempts.map((attempt) => ({
      launchKind: attempt.launchKind,
      launchStartedAt: attempt.phases.launchStartedAt,
      workerReadyAt: attempt.phases.workerReadyAt,
      startupMs: attempt.durations.startupMs,
    }))).toEqual([
      {
        launchKind: 'cold',
        launchStartedAt: '2026-08-12T10:02:00.000Z',
        workerReadyAt: '2026-08-12T10:03:00.000Z',
        startupMs: 60_000,
      },
      {
        launchKind: 'cold',
        launchStartedAt: '2026-08-12T10:09:00.000Z',
        workerReadyAt: '2026-08-12T10:10:00.000Z',
        startupMs: 60_000,
      },
    ]);
    expect(receipt.packets[0]?.attempts.reduce((total, attempt) => total + attempt.durations.recoveryMs, 0)).toBe(60_000);
    expect(receipt.packets[0]?.interventions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'rejection', at: '2026-08-12T10:06:00.000Z' }),
    ]));
  });

  it('attributes an owned launch by opaque identity id without leaking private identity state', async () => {
    const packetId = 'packet-funnel-identity';
    const sessionKey = 'codex-owned:funnel-identity';
    const identityId = 'codex-0123456789abcdef';
    const privateHome = join(dataDir, 'private-codex-home');
    writeCodexIdentitySession(sessionKey, identityId, privateHome);
    const lane = createLane({
      repoPath: dataDir,
      branch: 'inline/funnel-identity',
      runtime: 'codex',
      packetId,
    });
    attachSession(lane.id, sessionKey, 'system');
    const packet: OrchestratorPacket = {
      id: packetId,
      referenceLabel: 'PKT-IDENTITY',
      title: 'identity receipt',
      summary: 'identity receipt',
      workspaceTargetPath: dataDir,
      branchTarget: lane.branch,
      runtime: 'codex',
      dependencyLabels: [],
      dependencyPacketIds: [],
      queueState: 'held',
      releaseState: 'released',
      status: 'released',
      lane: null,
    };
    const missionState: OrchestratorMissionState = {
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-funnel-identity',
      repoPath: dataDir,
      runtime: 'codex',
      packets: [packet],
    };
    const [receipt, cost] = await Promise.all([
      projectMissionFunnel(missionState),
      aggregateMissionCost(missionState, new Map([[packetId, {
        sessionKey,
        runtime: 'codex',
      }]])),
    ]);
    const serialized = JSON.stringify(receipt);

    expect(receipt.packets[0]?.identityId).toBe(identityId);
    expect(receipt.packets[0]?.attempts[0]?.identityId).toBe(identityId);
    expect(receipt.packets[0]?.repoLabel).toBe(dataDir.split('/').at(-1));
    expect(receipt.packets[0]?.repoPath).toBeNull();
    expect(cost.packetCosts[0]?.identityId).toBe(identityId);
    expect(serialized).not.toContain(dataDir);
    expect(serialized).not.toContain(privateHome);
    expect(serialized).not.toContain('Private account label');
  });

  it('projects retries, output, review, approval, merge, recovery, and intervention truth without duplicate attempts', async () => {
    const missionId = 'mission-funnel-real-path';
    const packetId = 'packet-funnel-real-path';
    const firstSession = 'opencode-owned:funnel-shared';
    const secondSession = firstSession;

    writeOpencodeTranscript(firstSession, [
      {
        type: 'text',
        timestamp: '2026-08-12T10:04:30.000Z',
        part: { type: 'text', text: 'First attempt output' },
      },
      {
        type: 'text',
        timestamp: '2026-08-12T10:11:30.000Z',
        part: { type: 'text', text: 'Replacement started' },
      },
      {
        type: 'text',
        timestamp: '2026-08-12T10:14:00.000Z',
        part: { type: 'text', text: 'Replacement finished' },
      },
    ]);

    const firstLane = createLane({
      repoPath: dataDir,
      branch: 'inline/funnel-first',
      runtime: 'opencode',
      packetId,
    });
    setLaneStatus(firstLane.id, 'launching', 'system', 'launching_session');
    attachSession(firstLane.id, firstSession, 'system');
    setLaneStatus(firstLane.id, 'running', 'system', 'session_launched');
    appendEvent(firstLane.id, 'session_lost', 'system', { packetId });
    setLaneStatus(firstLane.id, 'recovering', 'system', 'session_lost');
    updateLane(firstLane.id, {
      packetId: '',
      outcome: 'discarded',
      outcomeNote: 'Superseded by rerun',
    });
    archiveLane(firstLane.id, 'user');
    stampLaneEvents(firstLane.id, [
      '2026-08-12T10:01:00.000Z',
      '2026-08-12T10:02:00.000Z',
      '2026-08-12T10:03:00.000Z',
      '2026-08-12T10:04:00.000Z',
      '2026-08-12T10:05:00.000Z',
      '2026-08-12T10:06:00.000Z',
      '2026-08-12T10:06:30.000Z',
      '2026-08-12T10:07:00.000Z',
    ]);

    const secondLane = createLane({
      repoPath: dataDir,
      branch: 'inline/funnel-second',
      runtime: 'opencode',
      packetId,
    });
    setLaneStatus(secondLane.id, 'launching', 'system', 'launching_session');
    attachSession(secondLane.id, secondSession, 'system');
    setLaneStatus(secondLane.id, 'running', 'system', 'session_launched');
    setLaneStatus(secondLane.id, 'reviewing', 'system', 'review_requested');
    const approval = createApproval({
      projectId: null,
      source: 'runtime',
      runtime: 'opencode',
      agent: 'funnel worker',
      sessionKey: secondSession,
      title: 'Approve merge',
      description: 'Approval fixture',
      summary: 'Ready to merge',
      risk: 'medium',
      metadata: { Packet: packetId, Lane: secondLane.id },
      continuation: { kind: 'lane', laneId: secondLane.id, verb: 'merge' },
    });
    setLaneStatus(secondLane.id, 'awaiting_input', 'user', 'approval_required');
    getSqlite().prepare(`
      UPDATE approvals
         SET status = 'approved', created_at = ?, updated_at = ?, resolved_at = ?,
             resolution_json = ?
       WHERE id = ?
    `).run(
      Date.parse('2026-08-12T10:16:00.000Z'),
      Date.parse('2026-08-12T10:17:00.000Z'),
      Date.parse('2026-08-12T10:17:00.000Z'),
      JSON.stringify({ action: 'approved', actor: 'desktop' }),
      approval.id,
    );
    appendEvent(secondLane.id, 'merge', 'user', { packetId });
    setLaneStatus(secondLane.id, 'completed', 'user', 'merged');
    stampLaneEvents(secondLane.id, [
      '2026-08-12T10:08:00.000Z',
      '2026-08-12T10:09:00.000Z',
      '2026-08-12T10:10:00.000Z',
      '2026-08-12T10:11:00.000Z',
      '2026-08-12T10:15:00.000Z',
      '2026-08-12T10:16:00.000Z',
      '2026-08-12T10:18:00.000Z',
      '2026-08-12T10:19:00.000Z',
    ]);

    const packet = {
      id: packetId,
      referenceLabel: 'P1',
      title: 'Persist mission funnel',
      summary: 'Persist mission funnel',
      workspaceTargetPath: dataDir,
      branchTarget: secondLane.branch,
      runtime: 'opencode',
      dependencyLabels: [],
      dependencyPacketIds: [],
      queueState: 'held',
      releaseState: 'released',
      releaseStatePayload: {
        mergeCommit: 'abc123',
        releasedAt: '2026-08-12T10:19:00.000Z',
        source: 'merge',
      },
      status: 'released',
      assignedModel: 'test/model',
      lane: null,
    } satisfies OrchestratorPacket;
    const state: OrchestratorMissionState = {
      ...createEmptyOrchestratorMissionState(),
      missionId,
      repoPath: dataDir,
      runtime: 'opencode' as const,
      packets: [packet],
      updatedAt: '2026-08-12T10:19:00.000Z',
    };
    writeOrchestratorControlPlaneState(state);
    recordMission({
      id: missionId,
      repoPath: dataDir,
      runtime: 'opencode',
      prompt: 'Persist mission funnel',
      summary: 'Persist mission funnel',
      constraints: '',
      packetMeta: [{ id: packetId, title: packet.title, referenceLabel: packet.referenceLabel }],
      missionState: state,
      totalWaves: 1,
    });
    getSqlite().prepare('UPDATE missions SET created_at = ? WHERE id = ?')
      .run(Date.parse('2026-08-12T10:00:00.000Z'), missionId);

    const status = await getMissionStatus({ includeCost: false, includeTiming: true });
    const receipt = status.funnel;
    if (!receipt) throw new Error('Mission status did not return the requested timing receipt.');
    expect(receipt.schemaVersion).toBe(1);
    expect(receipt.createdAt).toBe('2026-08-12T10:00:00.000Z');
    expect(receipt.terminalAt).toBe('2026-08-12T10:19:00.000Z');
    expect(receipt.attemptCount).toBe(2);
    expect(receipt.retryCount).toBe(1);
    expect(receipt.interventionCount).toBe(1);
    expect(receipt.recoveryEventCount).toBe(1);

    const packetReceipt = receipt.packets[0];
    expect(packetReceipt?.phases).toMatchObject({
      createdAt: null,
      enqueuedAt: null,
      claimedAt: '2026-08-12T10:01:00.000Z',
      launchStartedAt: '2026-08-12T10:02:00.000Z',
      workerReadyAt: '2026-08-12T10:03:00.000Z',
      firstOutputAt: '2026-08-12T10:04:30.000Z',
      lastOutputAt: '2026-08-12T10:14:00.000Z',
      reviewReadyAt: '2026-08-12T10:15:00.000Z',
      approvalRequestedAt: '2026-08-12T10:16:00.000Z',
      approvedAt: '2026-08-12T10:17:00.000Z',
      mergedAt: '2026-08-12T10:18:00.000Z',
      terminalAt: '2026-08-12T10:19:00.000Z',
    });
    expect(packetReceipt?.durations).toMatchObject({
      queueMs: null,
      startupMs: 60_000,
      firstOutputMs: 90_000,
      executionMs: 630_000,
      reviewMs: 60_000,
      approvalMs: 60_000,
      mergeMs: 60_000,
      totalMs: null,
    });
    expect(packetReceipt?.attempts).toHaveLength(2);
    expect(packetReceipt?.attempts.map((attempt) => ({
      first: attempt.phases.firstOutputAt,
      last: attempt.phases.lastOutputAt,
    }))).toEqual([
      { first: '2026-08-12T10:04:30.000Z', last: '2026-08-12T10:04:30.000Z' },
      { first: '2026-08-12T10:11:30.000Z', last: '2026-08-12T10:14:00.000Z' },
    ]);
    expect(packetReceipt?.interventions.map((event) => event.kind)).toEqual(['rerun_with_feedback']);
    expect(packetReceipt?.recoveryEvents.map((event) => event.kind)).toEqual(['session_lost']);
    expect(packetReceipt?.terminalDisposition).toBe('merged');
    expect(packetReceipt?.strictAutonomousClose).toBe(false);
    expect(packetReceipt?.governedAutonomousClose).toBe(false);

    const response = await statusRoute.GET(new NextRequest(
      `http://127.0.0.1/api/orchestrator/status?missionId=${missionId}&includeTiming=true`,
      { headers: { Host: '127.0.0.1' } },
    ));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      result: {
        funnel: {
          schemaVersion: 1,
          retryCount: 1,
          interventionCount: 1,
        },
      },
    });
  });

  it('does not attribute a session-only approval to an earlier packet that reused the session', async () => {
    const sessionKey = 'opencode-owned:funnel-approval-window';
    const firstPacketId = 'packet-funnel-approval-first';
    const secondPacketId = 'packet-funnel-approval-second';
    const firstLane = createLane({
      repoPath: dataDir,
      branch: 'inline/funnel-approval-first',
      runtime: 'opencode',
      packetId: firstPacketId,
    });
    attachSession(firstLane.id, sessionKey, 'system');
    const secondLane = createLane({
      repoPath: dataDir,
      branch: 'inline/funnel-approval-second',
      runtime: 'opencode',
      packetId: secondPacketId,
    });
    attachSession(secondLane.id, sessionKey, 'system');
    getSqlite().prepare("UPDATE lane_events SET timestamp = ? WHERE lane_id = ? AND verb = 'open_lane'")
      .run('2026-08-12T11:00:00.000Z', firstLane.id);
    getSqlite().prepare("UPDATE lane_events SET timestamp = ? WHERE lane_id = ? AND verb = 'attach_session'")
      .run('2026-08-12T11:00:01.000Z', firstLane.id);
    getSqlite().prepare("UPDATE lane_events SET timestamp = ? WHERE lane_id = ? AND verb = 'open_lane'")
      .run('2026-08-12T12:00:00.000Z', secondLane.id);
    getSqlite().prepare("UPDATE lane_events SET timestamp = ? WHERE lane_id = ? AND verb = 'attach_session'")
      .run('2026-08-12T12:00:01.000Z', secondLane.id);
    const approval = createApproval({
      source: 'runtime',
      runtime: 'opencode',
      agent: 'shared session worker',
      sessionKey,
      title: 'Approve later packet',
      description: 'Session-only approval fixture',
      summary: 'Ready',
      risk: 'medium',
      continuation: { kind: 'lane', laneId: secondLane.id, verb: 'merge' },
    });
    getSqlite().prepare('UPDATE approvals SET created_at = ?, updated_at = ? WHERE id = ?')
      .run(Date.parse('2026-08-12T12:10:00.000Z'), Date.parse('2026-08-12T12:10:00.000Z'), approval.id);
    const packetFor = (id: string, branch: string): OrchestratorPacket => ({
      id,
      referenceLabel: id,
      title: id,
      summary: id,
      workspaceTargetPath: dataDir,
      branchTarget: branch,
      runtime: 'opencode',
      dependencyLabels: [],
      dependencyPacketIds: [],
      queueState: 'held',
      releaseState: 'pending',
      status: 'blocked',
      lane: null,
    });
    const receipt = await projectMissionFunnel({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-funnel-approval-window',
      repoPath: dataDir,
      runtime: 'opencode',
      packets: [
        packetFor(firstPacketId, firstLane.branch),
        packetFor(secondPacketId, secondLane.branch),
      ],
    });
    const byPacket = new Map(receipt.packets.map((packet) => [packet.packetId, packet]));

    expect(byPacket.get(firstPacketId)?.phases.approvalRequestedAt).toBeNull();
    expect(byPacket.get(secondPacketId)?.phases.approvalRequestedAt).toBe('2026-08-12T12:10:00.000Z');
  });

  it('ignores a superseded attempt approval when projecting final approval timing', async () => {
    const packetId = 'packet-funnel-superseded-approval';
    const lane = createLane({
      repoPath: dataDir,
      branch: 'inline/funnel-superseded-approval',
      runtime: 'opencode',
      packetId,
    });
    const approvalInput = (title: string) => ({
      projectId: null,
      source: 'runtime' as const,
      runtime: 'opencode',
      agent: 'approval worker',
      sessionKey: `lane:${lane.id}`,
      title,
      description: title,
      summary: 'Ready',
      risk: 'medium' as const,
      metadata: { Packet: packetId, Lane: lane.id },
      continuation: { kind: 'lane' as const, laneId: lane.id, verb: 'merge' as const },
    });
    const oldApproval = createApproval(approvalInput('Old attempt approval'));
    getSqlite().prepare(`
      UPDATE approvals
         SET status = 'approved', created_at = ?, resolved_at = ?, args_json = ?
       WHERE id = ?
    `).run(
      Date.parse('2026-08-12T09:00:00.000Z'),
      Date.parse('2026-08-12T09:01:00.000Z'),
      JSON.stringify({ reviewSuperseded: true, reviewSupersededAt: Date.parse('2026-08-12T09:02:00.000Z') }),
      oldApproval.id,
    );
    const currentApproval = createApproval(approvalInput('Current attempt approval'));
    getSqlite().prepare(`
      UPDATE approvals
         SET status = 'approved', created_at = ?, resolved_at = ?
       WHERE id = ?
    `).run(
      Date.parse('2026-08-12T10:00:00.000Z'),
      Date.parse('2026-08-12T10:01:00.000Z'),
      currentApproval.id,
    );
    appendEvent(lane.id, 'merge', 'user', { packetId });
    setLaneStatus(lane.id, 'completed', 'user', 'merged');
    const packet: OrchestratorPacket = {
      id: packetId,
      referenceLabel: packetId,
      title: packetId,
      summary: packetId,
      workspaceTargetPath: dataDir,
      branchTarget: lane.branch,
      runtime: 'opencode',
      dependencyLabels: [],
      dependencyPacketIds: [],
      queueState: 'held',
      releaseState: 'released',
      status: 'released',
      lane: null,
    };

    const receipt = await projectMissionFunnel({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-funnel-superseded-approval',
      repoPath: dataDir,
      runtime: 'opencode',
      packets: [packet],
    });

    expect(receipt.packets[0]?.phases).toMatchObject({
      approvalRequestedAt: '2026-08-12T10:00:00.000Z',
      approvedAt: '2026-08-12T10:01:00.000Z',
    });
    expect(receipt.packets[0]?.interventions.map((entry) => entry.kind))
      .not.toContain('manual_merge_rescue');
  });

  it('keeps clean, approval-only, steered, failed, cancelled, and partial outcomes distinct', async () => {
    const missionId = 'mission-funnel-outcomes';
    const now = new Date().toISOString();
    const packet = (
      id: string,
      status: OrchestratorPacket['status'],
      releaseState: OrchestratorPacket['releaseState'],
      extra: Partial<OrchestratorPacket> = {},
    ): OrchestratorPacket => ({
      id,
      referenceLabel: id,
      title: id,
      summary: id,
      workspaceTargetPath: dataDir,
      branchTarget: `inline/${id}`,
      runtime: 'opencode',
      dependencyLabels: [],
      dependencyPacketIds: [],
      queueState: 'held',
      releaseState,
      status,
      lane: null,
      ...extra,
    });
    const packets = [
      packet('clean', 'released', 'released'),
      packet('approval-only', 'released', 'released'),
      packet('steered', 'released', 'released'),
      packet('failed', 'failed', 'pending'),
      packet('cancelled', 'blocked', 'pending', { operatorStopped: true, archivedAt: now }),
      packet('partial', 'archived', 'pending', { archivedAt: now }),
    ];
    const state: OrchestratorMissionState = {
      ...createEmptyOrchestratorMissionState(),
      missionId,
      repoPath: dataDir,
      runtime: 'opencode',
      packets,
      updatedAt: now,
    };
    writeOrchestratorControlPlaneState(state);
    recordMission({
      id: missionId,
      repoPath: dataDir,
      runtime: 'opencode',
      prompt: 'Outcome matrix',
      summary: 'Outcome matrix',
      constraints: '',
      packetMeta: packets.map((entry) => ({
        id: entry.id,
        title: entry.title,
        referenceLabel: entry.referenceLabel,
      })),
      missionState: state,
      totalWaves: 1,
    });

    const clean = createLane({ repoPath: dataDir, branch: 'inline/clean', runtime: 'opencode', packetId: 'clean' });
    appendEvent(clean.id, 'merge', 'orchestrator', { packetId: 'clean' });
    setLaneStatus(clean.id, 'completed', 'orchestrator', 'merged');

    const approvalOnly = createLane({
      repoPath: dataDir,
      branch: 'inline/approval-only',
      runtime: 'opencode',
      packetId: 'approval-only',
    });
    const approval = createApproval({
      projectId: null,
      source: 'runtime',
      runtime: 'opencode',
      agent: 'approval-only worker',
      sessionKey: `lane:${approvalOnly.id}`,
      title: 'Approve approval-only merge',
      description: 'Approval-only fixture',
      summary: 'Ready',
      risk: 'medium',
      metadata: { Packet: 'approval-only', Lane: approvalOnly.id },
      continuation: { kind: 'lane', laneId: approvalOnly.id, verb: 'merge' },
    });
    const approvedAt = Date.now();
    getSqlite().prepare(`
      UPDATE approvals
         SET status = 'approved', updated_at = ?, resolved_at = ?, resolution_json = ?
       WHERE id = ?
    `).run(
      approvedAt,
      approvedAt,
      JSON.stringify({ action: 'approved', actor: 'desktop' }),
      approval.id,
    );
    appendEvent(approvalOnly.id, 'merge', 'user', { packetId: 'approval-only' });
    setLaneStatus(approvalOnly.id, 'completed', 'user', 'merged');

    const steered = createLane({ repoPath: dataDir, branch: 'inline/steered', runtime: 'opencode', packetId: 'steered' });
    appendEvent(steered.id, 'steered_packet', 'orchestrator', { packetId: 'steered', source: 'operator' });
    appendEvent(steered.id, 'merge', 'orchestrator', { packetId: 'steered' });
    setLaneStatus(steered.id, 'completed', 'orchestrator', 'merged');

    const failed = createLane({ repoPath: dataDir, branch: 'inline/failed', runtime: 'opencode', packetId: 'failed' });
    setLaneStatus(failed.id, 'failed', 'system', 'runtime_failed');

    const cancelled = createLane({ repoPath: dataDir, branch: 'inline/cancelled', runtime: 'opencode', packetId: 'cancelled' });
    setLaneStatus(cancelled.id, 'paused', 'user', 'operator_stopped');

    const partial = createLane({ repoPath: dataDir, branch: 'inline/partial', runtime: 'opencode', packetId: 'partial' });
    updateLane(partial.id, { outcome: 'discarded', outcomeNote: 'Operator discarded partial result' }, 'user');
    archiveLane(partial.id, 'user');

    const status = await getMissionStatus({ includeCost: false, includeTiming: true });
    const receipt = status.funnel;
    if (!receipt) throw new Error('Mission status did not return the requested outcome receipt.');
    const byId = new Map(receipt.packets.map((entry) => [entry.packetId, entry]));

    expect(byId.get('clean')).toMatchObject({ terminalDisposition: 'merged', strictAutonomousClose: null });
    expect(byId.get('approval-only')).toMatchObject({ terminalDisposition: 'merged', governedAutonomousClose: null });
    expect(byId.get('steered')?.interventions.map((event) => event.kind)).toEqual(['steer']);
    expect(byId.get('failed')?.terminalDisposition).toBe('failed');
    expect(byId.get('cancelled')).toMatchObject({
      terminalDisposition: 'cancelled',
      phases: { terminalAt: expect.any(String) },
      interventions: [expect.objectContaining({ kind: 'stop' })],
    });
    expect(byId.get('partial')).toMatchObject({
      terminalDisposition: 'partial',
      interventions: [expect.objectContaining({ kind: 'archive' })],
    });
    expect(receipt.terminalPacketCount).toBe(6);
    expect(receipt.successfulPacketCount).toBe(3);
    expect(receipt.strictAutonomousCloseCount).toBe(0);
    expect(receipt.governedAutonomousCloseCount).toBe(0);
    expect(receipt.strictAutonomousCloseRate).toBeNull();
    expect(receipt.governedAutonomousCloseRate).toBeNull();
    expect(receipt.failedPacketCount).toBe(1);
    expect(receipt.interventionPacketCount).toBe(3);
    expect(receipt.failureRate).toBeCloseTo(1 / 6);
    expect(receipt.interventionRate).toBe(0.5);
  });
});
