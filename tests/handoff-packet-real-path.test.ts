import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, describe, expect, it } from 'vitest';
import type { HandoffPacket } from '@/lib/orchestrator/handoff-packet';

const testRoot = mkdtempSync(join(tmpdir(), 'o8-handoff-real-'));
const dataDir = join(testRoot, 'data');
const repoPath = join(testRoot, 'repo');
const handoffWorktreePath = join(testRoot, 'handoff-worktree');
const otherRepoPath = join(testRoot, 'other-repo');
const operatorToken = 'handoff-real-path-operator-token-0123456789';

mkdirSync(dataDir, { recursive: true });
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
writeFileSync(join(dataDir, 'ws-token'), `${operatorToken}\n`, 'utf-8');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' }).trim();
}

function createRepo(path: string) {
  mkdirSync(path, { recursive: true });
  git(path, 'init', '-b', 'main');
  git(path, 'config', 'user.name', 'Handoff Test');
  git(path, 'config', 'user.email', 'handoff@example.test');
  writeFileSync(join(path, 'notes.txt'), 'base\n', 'utf-8');
  git(path, 'add', 'notes.txt');
  git(path, 'commit', '-m', 'test: seed handoff workspace');
}

createRepo(repoPath);
createRepo(otherRepoPath);
git(repoPath, 'worktree', 'add', '-b', 'handoff-work', handoffWorktreePath);
writeFileSync(join(repoPath, 'notes.txt'), 'base\nworking change\n', 'utf-8');
writeFileSync(join(repoPath, 'untracked.txt'), 'new work\n', 'utf-8');
writeFileSync(join(handoffWorktreePath, 'notes.txt'), 'base\nworktree change\n', 'utf-8');
writeFileSync(join(handoffWorktreePath, 'handoff-untracked.txt'), 'worktree-only work\n', 'utf-8');

const history = await import('@/lib/mobile/orchestrator-thread-history');
const laneRegistry = await import('@/lib/lane/registry');
const approvals = await import('@/lib/approvals/store');
const handoff = await import('@/lib/orchestrator/handoff-packet');
const route = await import('@/app/api/orchestrator/handoff/route');

function createThread(input: {
  assistantBackend?: 'o8';
  assistantModel?: string;
  sessionId?: string;
}) {
  const threadId = history.createMobileOrchestratorThread({
    repoPath,
    backend: 'o8',
  }).id;
  history.appendMobileOrchestratorUserMessage({
    tabId: threadId,
    message: 'Continue the durable handoff slice.',
    repoPath,
    backend: 'o8',
  });
  history.upsertMobileOrchestratorAssistantMessage({
    tabId: threadId,
    messageId: `${threadId}-assistant`,
    content: 'The workspace is measured and the first approach was rejected.',
    repoPath,
    backend: input.assistantBackend,
    model: input.assistantModel,
    sessionId: input.sessionId,
  });
  return threadId;
}

afterAll(() => {
  delete process.env.CORTEX_IDE_DATA_DIR;
  delete process.env.O8_DATA_DIR;
  rmSync(testRoot, { recursive: true, force: true });
});

describe('handoff packet real path', () => {
  it('builds an authenticated packet from persisted thread, Git, lane, and approval state', async () => {
    const threadId = createThread({
      assistantBackend: 'o8',
      assistantModel: 'gateway/local',
      sessionId: 'source-session',
    });
    history.appendMobileOrchestratorUserMessage({
      tabId: threadId,
      message: 'Prepare the measured handoff packet now.',
      repoPath,
      backend: 'o8',
    });
    history.upsertMobileOrchestratorAssistantMessage({
      tabId: threadId,
      messageId: `${threadId}-second-assistant`,
      content: 'The handoff packet is ready for the destination.',
      repoPath,
      backend: 'o8',
      model: 'gateway/alternate',
    });
    const lane = laneRegistry.createLane({
      repoPath,
      worktreePath: handoffWorktreePath,
      branch: 'handoff-work',
      runtime: 'codex',
      packetId: 'pkt-handoff-real',
      sessionKey: 'source-session',
      projectId: null,
    });
    laneRegistry.updateLane(lane.id, { status: 'awaiting_input' }, 'orchestrator', {
      reason: 'A pending operator decision must survive the handoff.',
    });
    const approval = approvals.createApproval({
      projectId: null,
      source: 'runtime',
      runtime: 'codex',
      agent: 'source-worker',
      sessionKey: 'source-session',
      title: 'Review the handoff work',
      description: 'Independent review remains pending.',
      summary: 'The receiver must preserve this obligation.',
      risk: 'medium',
      continuation: { kind: 'lane', laneId: lane.id, verb: 'resume' },
    });

    const request = new NextRequest('https://operator.example.test/api/orchestrator/handoff', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${operatorToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        threadId,
        to: { backend: 'o8', model: 'target/default' },
        laneId: lane.id,
        intent: {
          objective: 'Continue without repeating completed work.',
          constraints: ['Keep review and merge gates unchanged.'],
          rejected: [{ approach: 'Transcript only', reason: 'It omits workspace and governance state.' }],
        },
        verifiedClaims: ['The focused handoff test passed.'],
        unverifiedClaims: ['The destination has enough context for every later turn.'],
      }),
    });
    const response = await route.POST(request);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    const payload = await response.json() as { ok: boolean; packet: HandoffPacket };
    const packet = payload.packet;

    expect(payload.ok).toBe(true);
    expect(packet.schema).toBe('o8/handoff.packet/v1');
    expect(packet.from).toEqual({
      backend: 'o8',
      model: 'gateway/alternate',
      sessionKey: null,
      runtime: null,
    });
    expect(packet.to).toEqual({ backend: 'o8', model: 'target/default' });
    expect(packet.carries).toEqual({
      narrative: 'full',
      intent: 'full',
      workspace: 'full',
      governance: 'summary',
      provenance: 'summary',
    });
    expect(packet.narrative.messages).toHaveLength(4);
    expect(packet.narrative.seams).toEqual([3]);
    expect(packet.workspace).toMatchObject({
      repoPath,
      worktreePath: handoffWorktreePath,
      branch: 'handoff-work',
      dirty: true,
    });
    expect(packet.workspace?.touchedFiles).toEqual(expect.arrayContaining(['notes.txt', 'handoff-untracked.txt']));
    expect(packet.workspace?.touchedFiles).not.toContain('untracked.txt');
    expect(packet.governance?.packets).toEqual([
      expect.objectContaining({ packetId: 'pkt-handoff-real', laneId: lane.id, status: 'awaiting_input' }),
    ]);
    expect(packet.governance?.approvals).toEqual([
      expect.objectContaining({ id: approval.id, status: 'pending' }),
    ]);
    expect(packet.governance?.events.some((event) => event.verb === 'status_change')).toBe(true);
    expect(packet.governance?.retryBudget.executionFailuresConsumed).toBeNull();
    expect(packet.provenance).toMatchObject({
      sourceTurnCount: 2,
      attributedAssistantTurns: 2,
      unattributedAssistantTurns: 0,
      claimsClassified: true,
    });
    expect(JSON.parse(JSON.stringify(packet))).toEqual(packet);
  });

  it('marks missing intent and governance as omitted without inventing legacy attribution', async () => {
    const threadId = createThread({});
    const packet = await handoff.buildHandoffPacket({
      threadId,
      to: { backend: 'o8', model: 'target/default' },
      handoffId: 'handoff-deterministic',
      createdAt: '2026-08-26T12:00:00.000Z',
    });

    expect(packet.from).toEqual({ backend: null, model: null, sessionKey: null, runtime: null });
    expect(packet.carries.intent).toBe('omitted');
    expect(packet.carries.governance).toBe('omitted');
    expect(packet.intent).toBeNull();
    expect(packet.governance).toBeNull();
    expect(packet.provenance).toMatchObject({
      attributedAssistantTurns: 0,
      unattributedAssistantTurns: 1,
      claimsClassified: false,
    });
  });

  it('rejects governance from a lane in another workspace', async () => {
    const threadId = createThread({ assistantBackend: 'o8', assistantModel: 'gateway/local' });
    const otherLane = laneRegistry.createLane({
      repoPath: otherRepoPath,
      worktreePath: otherRepoPath,
      branch: 'main',
      runtime: 'codex',
      packetId: 'pkt-other-workspace',
      projectId: null,
    });

    await expect(handoff.buildHandoffPacket({
      threadId,
      to: { backend: 'o8', model: 'target/default' },
      laneId: otherLane.id,
    })).rejects.toMatchObject({
      code: 'handoff_lane_workspace_mismatch',
      status: 409,
    });
  });

  it('rejects unauthenticated remote requests before reading a thread', async () => {
    const request = new NextRequest('https://remote.example.test/api/orchestrator/handoff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        threadId: 'missing-thread',
        to: { backend: 'o8', model: 'target/default' },
      }),
    });
    const response = await route.POST(request);
    expect(response.status).toBe(401);
  });

  it('rejects malformed claim lists instead of silently dropping them', async () => {
    const threadId = createThread({ assistantBackend: 'o8', assistantModel: 'gateway/local' });
    const request = new NextRequest('https://operator.example.test/api/orchestrator/handoff', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${operatorToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        threadId,
        to: { backend: 'o8', model: 'target/default' },
        verifiedClaims: 'not-an-array',
      }),
    });
    const response = await route.POST(request);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_handoff_request' },
    });
  });

  it('rejects a destination backend that is not registered', async () => {
    const threadId = createThread({ assistantBackend: 'o8', assistantModel: 'gateway/local' });
    await expect(handoff.buildHandoffPacket({
      threadId,
      to: { backend: 'missing-backend', model: 'target/default' },
    })).rejects.toMatchObject({
      code: 'invalid_handoff_destination',
      status: 400,
    });
  });
});
