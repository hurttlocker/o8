import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { HandoffIntent, HandoffPacket } from '@/lib/orchestrator/handoff-packet';

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
const chatHistoryStore = await import('@/lib/llm/chat-history-store');
const laneRegistry = await import('@/lib/lane/registry');
const approvals = await import('@/lib/approvals/store');
const handoff = await import('@/lib/orchestrator/handoff-packet');
const laneDiffFacts = await import('@/lib/lane/lane-diff-facts');
const laneCreationBase = await import('@/lib/lane/creation-base');
const backendCarry = await import('@/lib/orchestrator/backend-switch-carry');
const controlPlane = await import('@/lib/orchestrator/control-plane');
const orchestratorStore = await import('@/lib/orchestrator/store');
const route = await import('@/app/api/orchestrator/handoff/route');
const historyRoute = await import('@/app/api/orchestrator/history/route');

function createThread(input: {
  repoPath?: string;
  assistantBackend?: 'o8';
  assistantModel?: string;
  sessionId?: string;
}) {
  const threadRepoPath = input.repoPath ?? repoPath;
  const threadId = history.createMobileOrchestratorThread({
    repoPath: threadRepoPath,
    backend: 'o8',
  }).id;
  history.appendMobileOrchestratorUserMessage({
    tabId: threadId,
    message: 'Continue the durable handoff slice.',
    repoPath: threadRepoPath,
    backend: 'o8',
  });
  history.upsertMobileOrchestratorAssistantMessage({
    tabId: threadId,
    messageId: `${threadId}-assistant`,
    content: 'The workspace is measured and the first approach was rejected.',
    repoPath: threadRepoPath,
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
  it('persists the seam immediately before the accepted operator turn', () => {
    const threadId = createThread({ assistantBackend: 'o8', assistantModel: 'source/model' });
    history.appendMobileOrchestratorUserMessage({
      tabId: threadId,
      message: 'Continue after the seam.',
      messageId: 'handoff-user-turn',
      repoPath,
      backend: 'codex',
      handoff: {
        handoffId: 'handoff-atomic-seam',
        from: { backend: 'o8', model: 'source/model' },
        to: { backend: 'codex', model: 'destination/model' },
        lossless: false,
        carries: {
          narrative: 'full',
          intent: 'summary',
          workspace: 'full',
          governance: 'omitted',
          provenance: 'summary',
        },
      },
    });

    expect(chatHistoryStore.readPersistedLlmChat(threadId)?.history.messages.slice(-2)).toMatchObject([
      { id: 'handoff-atomic-seam', type: 'handoff', role: 'system' },
      { id: 'handoff-user-turn', role: 'user', content: 'Continue after the seam.' },
    ]);
    history.truncateMobileOrchestratorThreadFromMessage({
      tabId: threadId,
      messageId: 'handoff-user-turn',
    });
    expect(chatHistoryStore.readPersistedLlmChat(threadId)?.history.messages.some((message) => (
      message.id === 'handoff-atomic-seam' || message.id === 'handoff-user-turn'
    ))).toBe(false);
  });

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
    expect(packet.governance?.retryBudget).toMatchObject({
      executionFailuresConsumed: 0,
      byPacket: [expect.objectContaining({ packetId: 'pkt-handoff-real', attemptCount: 0 })],
    });
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

  it('normalizes source-native tool calls into portable described actions', async () => {
    const threadId = createThread({ assistantBackend: 'o8', assistantModel: 'gateway/local' });
    const persisted = chatHistoryStore.readPersistedLlmChat(threadId);
    if (!persisted) throw new Error('expected persisted thread');
    chatHistoryStore.persistCanonicalChatHistoryRecord(threadId, {
      ...persisted.history,
      messages: persisted.history.messages.map((message) => message.role === 'assistant'
        ? {
          ...message,
          toolCalls: [{
            name: 'source_native_edit',
            args: { file_path: '/source-only/path.ts' },
            preview: 'Updated the workspace file.',
            sideEffectClass: 'write' as const,
            status: 'done' as const,
          }],
        }
        : message),
    });

    const packet = await handoff.buildHandoffPacket({
      threadId,
      to: { backend: 'codex', model: 'destination/model' },
    });
    expect(packet.narrative.messages.find((message) => message.role === 'assistant')?.actions).toEqual([{
      description: 'Updated the workspace file.',
      sideEffect: 'write',
      status: 'completed',
    }]);
    const prelude = backendCarry.renderBackendSwitchHandoffPrelude(packet);
    expect(prelude).toContain('Updated the workspace file.');
    expect(prelude).not.toContain('source_native_edit');
    expect(prelude).not.toContain('file_path');
  });

  it('discovers thread-bound packet obligations and records the permanent lane seam', async () => {
    const threadId = createThread({ assistantBackend: 'o8', assistantModel: 'gateway/local' });
    const packetId = 'pkt-thread-bound-handoff';
    const lane = laneRegistry.createLane({
      repoPath,
      worktreePath: handoffWorktreePath,
      branch: 'handoff-work',
      runtime: 'codex',
      packetId,
      sessionKey: 'governed-session',
      projectId: null,
    });
    laneRegistry.updateLane(lane.id, { status: 'running' });
    const state = orchestratorStore.createEmptyOrchestratorMissionState();
    state.missionId = 'mission-thread-bound-handoff';
    state.repoPath = repoPath;
    state.packets = [{
      id: packetId,
      referenceLabel: 'P1',
      title: 'Preserve governed work',
      summary: 'The receiver inherits this active obligation.',
      workspaceTargetPath: handoffWorktreePath,
      branchTarget: 'handoff-work',
      runtime: 'codex',
      dependencyLabels: [],
      dependencyPacketIds: [],
      queueState: 'held',
      releaseState: 'pending',
      status: 'running',
      attemptCount: 2,
      maxAttempts: 4,
      recoveryCount: 1,
      typecheckAutoRetries: 1,
      orchestratorThreadId: threadId,
    }];
    controlPlane.writeOrchestratorControlPlaneState(state);

    const prepared = await backendCarry.prepareBackendSwitchHandoff({
      threadId,
      to: { backend: 'codex', model: 'destination/model' },
    });
    expect(prepared?.packet.governance).toMatchObject({
      packets: [expect.objectContaining({ packetId, laneId: lane.id, attemptCount: 2, maxAttempts: 4 })],
      retryBudget: {
        executionFailuresConsumed: 2,
        limit: 4,
        byPacket: [expect.objectContaining({ packetId, recoveryCount: 1, typecheckAutoRetries: 1 })],
      },
    });
    if (!prepared) throw new Error('expected governed handoff');
    history.appendMobileOrchestratorUserMessage({
      tabId: threadId,
      repoPath,
      message: 'Continue the governed work.',
      backend: 'codex',
      handoff: {
        handoffId: prepared.packet.handoffId,
        from: prepared.seam.from,
        to: prepared.seam.to,
        lossless: prepared.seam.lossless,
        carries: prepared.packet.carries,
        packet: prepared.packet as unknown as Record<string, unknown>,
      },
    });
    backendCarry.recordBackendSwitchHandoffAudit(prepared);

    expect(laneRegistry.getLaneEvents(lane.id, 20).at(-1)).toMatchObject({
      verb: 'handoff',
      actor: 'orchestrator',
      payload: {
        handoffId: prepared.packet.handoffId,
        threadId,
        lossless: false,
      },
    });
    const historyResponse = await historyRoute.GET(new NextRequest(
      `https://operator.example.test/api/orchestrator/history?threadId=${threadId}`,
      { headers: { Authorization: `Bearer ${operatorToken}` } },
    ));
    expect(historyResponse.status).toBe(200);
    const historyPayload = await historyResponse.json() as {
      timeline: Array<{ kind: string; handoff?: { handoffId: string }; audits: Array<{ laneId: string }> }>;
    };
    expect(historyPayload.timeline).toContainEqual(expect.objectContaining({
      kind: 'handoff',
      handoff: expect.objectContaining({ handoffId: prepared.packet.handoffId }),
      audits: [expect.objectContaining({ laneId: lane.id })],
    }));
    controlPlane.writeOrchestratorControlPlaneState(orchestratorStore.createEmptyOrchestratorMissionState());
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

// Resource integration: real Git, persisted lanes and authenticated handoff
// routes. These tests do not invoke a model or a worker runtime.
describe('handoff workspace freshness real Git integration', () => {
  function persistPacket(packet: HandoffPacket) {
    history.appendMobileOrchestratorUserMessage({
      tabId: packet.threadId,
      repoPath: packet.workspace!.worktreePath,
      message: 'Continue from the handoff.',
      backend: 'codex',
      handoff: {
        handoffId: packet.handoffId,
        from: packet.from.backend ? { backend: packet.from.backend, model: packet.from.model } : null,
        to: packet.to,
        lossless: false,
        carries: packet.carries,
        packet: packet as unknown as Record<string, unknown>,
      },
    });
    const saved = chatHistoryStore.readPersistedLlmChat(packet.threadId)?.history.messages
      .find((message) => message.id === packet.handoffId)?.handoff?.packet;
    expect(saved).toEqual(packet);
    return saved as unknown as HandoffPacket;
  }

  async function capturePacket(intent?: HandoffIntent) {
    const workspacePath = mkdtempSync(join(testRoot, 'freshness-'));
    createRepo(workspacePath);
    writeFileSync(join(workspacePath, 'notes.txt'), 'staged bytes\n');
    git(workspacePath, 'add', 'notes.txt');
    writeFileSync(join(workspacePath, 'notes.txt'), 'working bytes A\n');
    writeFileSync(join(workspacePath, 'untracked.txt'), 'untracked bytes A\n');
    const indexPath = join(workspacePath, '.git', 'index');
    const indexBefore = readFileSync(indexPath);
    const lane = laneRegistry.createLane({
      repoPath: workspacePath,
      worktreePath: workspacePath,
      branch: 'main',
      runtime: 'codex',
      projectId: null,
    });
    const threadId = createThread({
      repoPath: workspacePath,
      assistantBackend: 'o8',
      assistantModel: 'source/model',
    });
    const response = await route.POST(new NextRequest('https://operator.example.test/api/orchestrator/handoff', {
      method: 'POST',
      headers: { Authorization: `Bearer ${operatorToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId, laneId: lane.id, intent, to: { backend: 'codex', model: 'target/model' } }),
    }));
    expect(response.status).toBe(200);
    const { packet } = await response.json() as { packet: HandoffPacket };
    const saved = persistPacket(packet);
    expect(readFileSync(indexPath)).toEqual(indexBefore);
    return { packet: saved as unknown as HandoffPacket, workspacePath, lane, threadId, indexPath, indexBefore };
  }

  it('exports a diagnostic-only evidence companion rehearsal', async () => {
    const intent: HandoffIntent = {
      objective: 'Make this respond faster.',
      constraints: ['Keep the layout and existing behavior.', 'Do not deploy.'],
      rejected: [],
    };
    const { packet, workspacePath, lane, threadId, indexPath, indexBefore } = await capturePacket(intent);
    const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
    const original = JSON.stringify(packet);
    const sourceBefore = readFileSync(join(workspacePath, 'notes.txt'));
    const headBefore = git(workspacePath, 'rev-parse', 'HEAD');
    const statusBefore = git(workspacePath, 'status', '--porcelain=v1');
    const unchanged = await handoff.inspectHandoffWorkspaceFreshness(packet);
    expect(unchanged).toMatchObject({ status: 'fresh', reason: 'snapshot-matched' });
    expect(unchanged.currentFingerprint).toBe(packet.workspace!.evidence!.diffFingerprint);

    // Fixture actor B is test code inspecting the persisted packet, not a worker.
    writeFileSync(join(workspacePath, 'notes.txt'), 'working bytes B\n');
    const sourceAfter = readFileSync(join(workspacePath, 'notes.txt'));
    const headAfter = git(workspacePath, 'rev-parse', 'HEAD');
    const statusAfter = git(workspacePath, 'status', '--porcelain=v1');
    expect(sourceAfter).not.toEqual(sourceBefore);
    expect(sourceAfter.length).toBe(sourceBefore.length);
    expect(headAfter).toBe(headBefore);
    expect(statusAfter).toBe(statusBefore);
    const changed = await handoff.inspectHandoffWorkspaceFreshness(packet);
    expect(changed).toMatchObject({ status: 'stale', reason: 'snapshot-changed' });
    expect(changed.currentFingerprint).not.toBe(changed.expectedFingerprint);

    const legacy = structuredClone(packet);
    delete legacy.workspace!.evidence;
    const missing = await handoff.inspectHandoffWorkspaceFreshness(legacy);
    expect(missing).toEqual({
      status: 'unavailable', reason: 'evidence-missing', expectedFingerprint: null, currentFingerprint: null,
    });
    const refreshed = persistPacket(await handoff.buildHandoffPacket({
      threadId, laneId: lane.id, to: packet.to, intent: packet.intent!,
    }));
    const reobserved = await handoff.inspectHandoffWorkspaceFreshness(refreshed);
    const originalAfter = await handoff.inspectHandoffWorkspaceFreshness(packet);
    expect(reobserved).toMatchObject({ status: 'fresh', reason: 'snapshot-matched' });
    expect(refreshed.workspace!.evidence!.diffFingerprint).toBe(changed.currentFingerprint);
    expect(refreshed.handoffId).not.toBe(packet.handoffId);
    expect(refreshed.intent).toEqual(intent);
    expect(originalAfter).toEqual(changed);
    expect(JSON.stringify(packet)).toBe(original);
    const persistedOriginal = chatHistoryStore.readPersistedLlmChat(threadId)?.history.messages
      .find((message) => message.id === packet.handoffId)?.handoff?.packet;
    expect(persistedOriginal).toEqual(packet);
    expect(readFileSync(indexPath)).toEqual(indexBefore);

    const receipt = {
      schema: 'o8/handoff-evidence-rehearsal/v1', result: 'passed',
      actors: { A: 'fixture capture code', B: 'fixture inspection code', actualAgents: false },
      intent: { kind: 'placeholder narrative only', value: intent, admittedIntentRef: null },
      boundaries: { workerDispatched: false, actEnforced: false, aodlAdmissionRun: false, finalR1Acceptance: null },
      original: {
        handoffId: packet.handoffId, threadId, evidence: packet.workspace!.evidence,
        serializedPacketSha256: digest(original),
      },
      observations: [
        { sequence: 1, scenario: 'unchanged', result: 'passed', diagnostic: unchanged },
        { sequence: 2, scenario: 'already-dirty-mutation', result: 'passed', diagnostic: changed,
          change: { file: 'notes.txt', beforeSha256: digest(sourceBefore), afterSha256: digest(sourceAfter),
            beforeBytes: sourceBefore.length, afterBytes: sourceAfter.length,
            headBefore, headAfter, porcelainBefore: statusBefore, porcelainAfter: statusAfter } },
        { sequence: 3, scenario: 'missing-evidence', result: 'passed', diagnostic: missing,
          input: 'in-memory legacy copy of the original; workspace.evidence removed' },
        { sequence: 4, scenario: 're-observation', result: 'passed', diagnostic: reobserved,
          handoffId: refreshed.handoffId, evidence: refreshed.workspace!.evidence, originalAfter },
      ],
      assertions: { persistedOriginalPreserved: 'passed', normalGitIndexPreserved: 'passed',
        placeholderIntentPreserved: 'passed', originalRemainsStale: 'passed' },
      notRun: ['admitted authored R1', 'actual worker handoff', 'receiver ACT enforcement',
        'compaction', 'performance/layout acceptance', 'final verification against R1'],
    };
    if (process.env.O8_HANDOFF_REHEARSAL_RECEIPT) {
      writeFileSync(process.env.O8_HANDOFF_REHEARSAL_RECEIPT, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
    }
  });

  it('keeps the exact snapshot fresh across persisted handoff and preserves the real index', async () => {
    const { packet, workspacePath, lane, indexPath, indexBefore } = await capturePacket();
    expect(packet.workspace?.evidence).toMatchObject({
      laneId: lane.id,
      headSha: git(workspacePath, 'rev-parse', 'HEAD'),
      against: git(workspacePath, 'rev-parse', 'main'),
      diffFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      snapshotTreeHash: expect.stringMatching(/^[0-9a-f]{40}$/),
    });
    const before = JSON.stringify(packet);
    const result = await handoff.inspectHandoffWorkspaceFreshness(packet);
    expect(result).toEqual({
      status: 'fresh', reason: 'snapshot-matched',
      expectedFingerprint: packet.workspace?.evidence?.diffFingerprint,
      currentFingerprint: packet.workspace?.evidence?.diffFingerprint,
    });
    expect(JSON.stringify(packet)).toBe(before);
    expect(readFileSync(indexPath)).toEqual(indexBefore);
    expect(JSON.stringify(packet.workspace?.evidence)).not.toContain('working bytes');
  });

  it.each(['notes.txt', 'untracked.txt'])('detects a same-porcelain content mutation in %s', async (file) => {
    const { packet, workspacePath, lane, threadId, indexPath, indexBefore } = await capturePacket();
    const head = git(workspacePath, 'rev-parse', 'HEAD');
    const porcelain = git(workspacePath, 'status', '--porcelain=v1');
    const previousBytes = readFileSync(join(workspacePath, file), 'utf8');
    writeFileSync(join(workspacePath, file), previousBytes.replace(' A\n', ' B\n'));
    expect(readFileSync(join(workspacePath, file)).length).toBe(Buffer.byteLength(previousBytes));
    expect(git(workspacePath, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(workspacePath, 'status', '--porcelain=v1')).toBe(porcelain);
    const result = await handoff.inspectHandoffWorkspaceFreshness(packet);
    expect(result).toMatchObject({ status: 'stale', reason: 'snapshot-changed' });
    expect(result.currentFingerprint).not.toBe(result.expectedFingerprint);
    const refreshed = await handoff.buildHandoffPacket({
      threadId, laneId: lane.id, to: packet.to,
    });
    expect(refreshed.workspace?.evidence?.diffFingerprint).toBe(result.currentFingerprint);
    expect(await handoff.inspectHandoffWorkspaceFreshness(refreshed)).toMatchObject({ status: 'fresh' });
    expect(packet.workspace?.evidence?.diffFingerprint).toBe(result.expectedFingerprint);
    expect(readFileSync(indexPath)).toEqual(indexBefore);
  });

  it('detects HEAD movement even when worktree contents stay identical', async () => {
    const { packet, workspacePath } = await capturePacket();
    git(workspacePath, 'commit', '--allow-empty', '--only', '-m', 'test: advance head');
    expect(await handoff.inspectHandoffWorkspaceFreshness(packet)).toMatchObject({
      status: 'stale', reason: 'snapshot-changed',
    });
  });

  it('never calls legacy or missing workspace evidence fresh', async () => {
    expect(await handoff.inspectHandoffWorkspaceFreshness(null)).toMatchObject({ status: 'unavailable' });
    expect(await handoff.inspectHandoffWorkspaceFreshness(undefined)).toMatchObject({ status: 'unavailable' });
    for (const malformed of ['packet', 1, [], { schema: 'unknown' }, { schema: 'o8/handoff.packet/v1', workspace: 1 }]) {
      expect(await handoff.inspectHandoffWorkspaceFreshness(malformed)).toMatchObject({ status: 'unavailable' });
    }
    const { packet } = await capturePacket();
    delete packet.workspace!.evidence;
    expect(await handoff.inspectHandoffWorkspaceFreshness(packet)).toEqual({
      status: 'unavailable', reason: 'evidence-missing', expectedFingerprint: null, currentFingerprint: null,
    });
    packet.workspace = null;
    expect(await handoff.inspectHandoffWorkspaceFreshness(packet)).toMatchObject({
      status: 'unavailable', reason: 'evidence-missing',
    });
  });

  it('rejects malformed evidence and another workspace without reading it as current', async () => {
    const { packet } = await capturePacket();
    const evidence = packet.workspace!.evidence!;
    packet.workspace!.evidence = { ...evidence, diffFingerprint: 'not-an-exact-fingerprint' };
    expect(await handoff.inspectHandoffWorkspaceFreshness(packet)).toMatchObject({
      status: 'unavailable', reason: 'evidence-invalid',
    });
    packet.workspace!.evidence = evidence;
    packet.workspace!.worktreePath = otherRepoPath;
    expect(await handoff.inspectHandoffWorkspaceFreshness(packet)).toMatchObject({
      status: 'unavailable', reason: 'workspace-mismatch',
    });
  });

  it('keeps a pinned local base when the creation receipt disappears during observation', async () => {
    const { packet, lane, threadId } = await capturePacket();
    const base = packet.workspace!.evidence!.against;
    const receipt = vi.spyOn(laneCreationBase, 'readLaneCreationBaseCommit')
      .mockReturnValueOnce(base).mockReturnValue(null);
    try {
      const recaptured = await handoff.buildHandoffPacket({ threadId, laneId: lane.id, to: packet.to });
      expect(receipt).toHaveBeenCalledTimes(1);
      expect(recaptured.workspace?.evidence).toEqual(packet.workspace?.evidence);
      // Once the receipt is absent, later captures cannot silently fetch or
      // substitute a moving base. The previously captured packet is unchanged.
      expect(await handoff.inspectHandoffWorkspaceFreshness(packet)).toMatchObject({
        status: 'unavailable', reason: 'evidence-unavailable',
      });
    } finally {
      receipt.mockRestore();
    }
  });

  it('rejects invalid or unavailable pinned bases without a legacy fallback', async () => {
    const { lane } = await capturePacket();
    await expect(laneDiffFacts.getLaneSpokenDiffFacts(lane, { pinnedCreationBaseCommit: '' }))
      .rejects.toThrow('Pinned snapshot base must be a full Git object ID.');
    await expect(laneDiffFacts.getLaneSpokenDiffFacts(lane, { pinnedCreationBaseCommit: 'f'.repeat(40) }))
      .rejects.toThrow('Saved packet creation base');
  });

  it('refuses a missing lane rather than treating matching hashes as authority', async () => {
    const { packet } = await capturePacket();
    packet.workspace!.evidence!.laneId = 'lane-no-longer-present';
    expect(await handoff.inspectHandoffWorkspaceFreshness(packet)).toMatchObject({
      status: 'unavailable', reason: 'lane-unavailable',
    });
  });

  it('omits evidence if HEAD moves after the shared snapshot reader returns', async () => {
    const { packet, workspacePath, lane, threadId, indexPath, indexBefore } = await capturePacket();
    const readFacts = laneDiffFacts.getLaneSpokenDiffFacts;
    const reader = vi.spyOn(laneDiffFacts, 'getLaneSpokenDiffFacts').mockImplementationOnce(async (...args) => {
      const facts = await readFacts(...args);
      const nextHead = git(workspacePath, 'commit-tree', 'HEAD^{tree}', '-p', facts.headSha, '-m', 'test: race snapshot head');
      git(workspacePath, 'update-ref', 'HEAD', nextHead, facts.headSha);
      return facts;
    });
    try {
      const raced = await handoff.buildHandoffPacket({ threadId, laneId: lane.id, to: packet.to });
      expect(raced.workspace?.evidence).toBeNull();
      expect(await handoff.inspectHandoffWorkspaceFreshness(raced)).toMatchObject({ status: 'unavailable' });
      expect(readFileSync(indexPath)).toEqual(indexBefore);
    } finally {
      reader.mockRestore();
    }
  });

  it('returns generic unavailable diagnostics when a recorded worktree disappears', async () => {
    const { packet, workspacePath } = await capturePacket();
    renameSync(workspacePath, `${workspacePath}-moved`);
    const result = await handoff.inspectHandoffWorkspaceFreshness(packet);
    expect(result).toMatchObject({ status: 'unavailable', reason: 'evidence-unavailable', currentFingerprint: null });
    expect(JSON.stringify(result)).not.toContain(workspacePath);
  });

  it('keeps a lane-less handoff backward compatible without inventing exact evidence', async () => {
    const threadId = createThread({ assistantBackend: 'o8' });
    const packet = await handoff.buildHandoffPacket({ threadId, to: { backend: 'codex', model: null } });
    expect(packet.workspace?.evidence).toBeNull();
    expect(await handoff.inspectHandoffWorkspaceFreshness(packet)).toMatchObject({
      status: 'unavailable', reason: 'evidence-missing',
    });
  });
});
