import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import type { CompletionVerificationResult } from '@/lib/supervisor/completion-verification';

const h = vi.hoisted(() => ({
  perform: vi.fn(), verify: vi.fn(), commit: vi.fn(), capture: vi.fn(), probe: vi.fn(), transcript: vi.fn(),
}));
vi.mock('@/lib/runtime/actions', () => ({ performRuntimeAction: h.perform }));
vi.mock('@/lib/runtime/inventory', () => ({
  getRuntimeInventorySnapshot: vi.fn(async () => ({ agents: [] })),
}));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}) }));
vi.mock('@/lib/command-center/snapshot', () => ({ invalidateCommandCenterSnapshotCaches: vi.fn() }));
vi.mock('@/lib/mobile/inbox', () => ({ invalidateInboxCache: vi.fn() }));
vi.mock('@/lib/supervisor/completion-liveness', () => ({
  shouldDeferCompletionForLiveRuntime: vi.fn(async () => false),
}));
vi.mock('@/lib/orchestrator/cost-persistence', () => ({ persistRuntimeSessionCost: vi.fn(async () => {}) }));
vi.mock('@/lib/lane/no-changes-produced', () => ({ probeNoChangesProduced: h.probe }));
vi.mock('@/lib/supervisor/completion-verification', () => ({
  runCompletionVerification: h.verify, autoCommitCompletionWorktree: h.commit,
}));
vi.mock('@/lib/orchestrator/context-relay', () => ({ capturePacketCompletionContext: h.capture }));
vi.mock('@/lib/runtime/transcript', () => ({ readRuntimeTranscript: h.transcript }));

const dataDir = mkdtempSync(join(tmpdir(), 'o8-completion-steer-race-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
const { closeDb, getSqlite } = await import('@/lib/db');
const { createLane, getLane, setLaneStatus, updateLane } = await import('@/lib/lane/registry');
const { recordLaneEvent } = await import('@/lib/lane/events');
const { persistLanePacketHold } = await import('@/lib/lane/packet-stop-hold');
const { readOrchestratorControlPlaneState, writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const { handleAgentCompletion } = await import('@/lib/supervisor/agent-completion');
const { getWatchedAgents, ingestAgentCompletionSignal, registerWatchedAgent,
  startSupervisorLoop, stopSupervisorLoop, unregisterWatchedAgent } = await import('@/lib/supervisor/agent-supervisor');
const steerRoute = await import('@/app/api/orchestrator/steer-packet/route');
const runsRoute = await import('@/app/api/panel/managed-runs/route');

const dependencies = {
  enqueueAutoReview: vi.fn(async () => {}),
  triggerHeadlessSprintTick: vi.fn(async () => {}),
  queueReviewContinuation: vi.fn(),
  enqueueVerificationFailureInboxItem: vi.fn(async () => 'test-inbox'),
};
const broadcast = vi.fn();
const verified: CompletionVerificationResult = { ok: true, kind: 'typecheck', output: '' };
let sequence = 0;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  const id = `pkt-completion-race-${++sequence}`;
  const repoPath = join(dataDir, id);
  const sessionKey = `claude-code-owned:${id}`;
  const lane = createLane({ repoPath, worktreePath: repoPath, branch: `inline/${id}`,
    runtime: 'claude-code', packetId: id, sessionKey });
  setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');
  const packet: OrchestratorPacket = {
    id, referenceLabel: id, title: id, summary: id, runtime: 'claude-code',
    workspaceTargetPath: repoPath, branchTarget: `inline/${id}`,
    dependencyLabels: [], dependencyPacketIds: [], queueState: 'held',
    releaseState: 'pending', status: 'awaiting_review', operatorStopped: false,
    blockedReason: null, lastEventAt: null, lastEventLabel: null, archivedAt: null, review: null,
    lane: { tileId: lane.id, tabId: lane.id, laneId: lane.id, repoPath,
      worktreePath: repoPath, runtime: 'claude-code', sessionKey },
  };
  writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(),
    missionId: `mission-${id}`, repoPath, packets: [packet] });
  recordLaneEvent(lane.id, 'runtime_process_exit', 'system', { surfaceId: sessionKey, exitCode: 0 });
  h.perform.mockResolvedValue({ ok: true, status: 'accepted', sessionKey, note: 'accepted' });
  registerWatchedAgent(sessionKey, repoPath, id, 'test');
  broadcast.mockClear();
  return { packet, lane, sessionKey };
}

function request(path: string, body: unknown) {
  return new NextRequest(`http://localhost${path}`, { method: 'POST', headers: {
    authorization: `Bearer ${getOrCreateWsToken()}`, 'content-type': 'application/json',
  }, body: JSON.stringify(body) });
}
function steer(packetId: string) {
  return steerRoute.POST(request('/api/orchestrator/steer-packet', {
    packetId, message: 'Run the next verification', idempotencyKey: `steer-${packetId}`,
  }));
}
function register(packet: OrchestratorPacket, suffix: string) {
  const id = `race${sequence}${suffix}`;
  return runsRoute.POST(request('/api/panel/managed-runs', {
    id, session: `cortex-run-${id}`, command: 'node --version',
    cwd: packet.workspaceTargetPath, packetId: packet.id, laneId: packet.lane?.laneId,
  }));
}
function delayVerification() {
  const entered = deferred<void>();
  const result = deferred<CompletionVerificationResult>();
  h.verify.mockImplementationOnce(() => { entered.resolve(); return result.promise; });
  return { entered: entered.promise, ...result };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  h.perform.mockReset();
  h.verify.mockReset().mockResolvedValue(verified);
  h.commit.mockReset().mockResolvedValue(false);
  h.probe.mockReset().mockResolvedValue({ noChangesProduced: false });
  h.capture.mockReset().mockResolvedValue({});
  h.transcript.mockReset().mockResolvedValue([]);
  startSupervisorLoop({
    fetchFleetStatus: async () => [], fetchTranscript: async () => [],
    steerAgent: async () => {}, interruptAgent: async () => {},
    relaunchAgent: async () => ({ status: 'held', reason: 'test' }),
    broadcastAgentUpdate: broadcast, queueOrchestratorEscalation: vi.fn(),
    onAgentCompletion: (surfaceId, outcome) => handleAgentCompletion(surfaceId, outcome, dependencies),
  });
  stopSupervisorLoop();
});
afterEach(() => {
  for (const watched of getWatchedAgents()) unregisterWatchedAgent(watched.surfaceId);
  stopSupervisorLoop();
  vi.clearAllTimers();
  vi.useRealTimers();
});
afterAll(() => { closeDb(); rmSync(dataDir, { recursive: true, force: true }); });

describe('completion and steer overlap through production callbacks and routes', () => {
  it.each(['pass', 'fail', 'throw'] as const)('discards a delayed %s result while the next turn remains admitted', async (outcome) => {
    const { packet, lane, sessionKey } = fixture();
    const delayed = delayVerification();
    const completion = ingestAgentCompletionSignal(sessionKey);
    await delayed.entered;
    expect((await steer(packet.id)).status).toBe(200);
    expect((await register(packet, 'before')).status).toBe(200);
    closeDb();
    if (outcome === 'throw') delayed.reject(new Error('old verifier failed'));
    else delayed.resolve({ ...verified, ok: outcome === 'pass' });
    expect(await completion).toBe(true);

    expect(getLane(lane.id)?.status).toBe('running');
    expect((await register(packet, 'after')).status).toBe(200);
    expect(dependencies.enqueueAutoReview).not.toHaveBeenCalled();
    expect(dependencies.triggerHeadlessSprintTick).not.toHaveBeenCalled();
    expect(dependencies.enqueueVerificationFailureInboxItem).not.toHaveBeenCalled();
    expect(h.commit).toHaveBeenCalledTimes(1);
    expect(readOrchestratorControlPlaneState().packets[0]?.attemptCount).toBe(0);
    expect(getWatchedAgents().find((entry) => entry.surfaceId === sessionKey)?.completionReported).toBe(false);
    expect(broadcast).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));

    recordLaneEvent(lane.id, 'runtime_process_exit', 'system', { surfaceId: sessionKey, exitCode: 0 });
    expect((await register(packet, 'exited')).status).toBe(409);
    expect(await ingestAgentCompletionSignal(sessionKey)).toBe(true);
    expect(getLane(lane.id)?.status).toBe('reviewing');
    expect(dependencies.enqueueAutoReview).toHaveBeenCalledTimes(1);
  });

  it('rejects an old completion even when the newer turn has already exited', async () => {
    const { packet, lane, sessionKey } = fixture();
    const delayed = delayVerification();
    const completion = ingestAgentCompletionSignal(sessionKey);
    await delayed.entered;
    expect((await steer(packet.id)).status).toBe(200);
    recordLaneEvent(lane.id, 'runtime_process_exit', 'system', { surfaceId: sessionKey, exitCode: 0 });
    delayed.resolve(verified);
    await completion;
    expect(dependencies.enqueueAutoReview).not.toHaveBeenCalled();
    expect((await register(packet, 'exited')).status).toBe(409);
    expect(getWatchedAgents().find((entry) => entry.surfaceId === sessionKey)?.completionReported).toBe(false);
  });

  it('preserves an operator hold and never restores its removed watcher', async () => {
    const { packet, lane, sessionKey } = fixture();
    const delayed = delayVerification();
    const completion = ingestAgentCompletionSignal(sessionKey);
    await delayed.entered;
    await persistLanePacketHold(packet.id);
    setLaneStatus(lane.id, 'paused', 'user', 'operator_stopped');
    unregisterWatchedAgent(sessionKey);
    delayed.resolve(verified);
    await completion;
    expect(getLane(lane.id)?.status).toBe('paused');
    expect((await register(packet, 'held')).status).toBe(409);
    expect((await steer(packet.id)).status).toBe(409);
    expect(getWatchedAgents()).toHaveLength(0);
    expect(dependencies.enqueueAutoReview).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('does not apply old completion state or watcher persistence to a rebound session', async () => {
    const { lane, sessionKey } = fixture();
    const delayed = delayVerification();
    const completion = ingestAgentCompletionSignal(sessionKey);
    await delayed.entered;
    updateLane(lane.id, { sessionKey: `${sessionKey}-replacement` });
    registerWatchedAgent(sessionKey, lane.repoPath, 'new watch', 'new prompt');
    const replacement = getWatchedAgents().find((entry) => entry.surfaceId === sessionKey);
    delayed.resolve(verified);
    await completion;
    expect(getWatchedAgents().find((entry) => entry.surfaceId === sessionKey)).toBe(replacement);
    expect(getSqlite().prepare('SELECT prompt FROM watched_agents WHERE surface_id = ?').get(sessionKey)).toEqual({ prompt: 'new prompt' });
    expect(dependencies.enqueueAutoReview).not.toHaveBeenCalled();
  });

  it('does not let a finished turn cleanup timer delete a newly registered watch', async () => {
    const { lane, sessionKey } = fixture();
    await ingestAgentCompletionSignal(sessionKey);
    registerWatchedAgent(sessionKey, lane.repoPath, 'successor', 'new prompt');
    const replacement = getWatchedAgents().find((entry) => entry.surfaceId === sessionKey);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getWatchedAgents().find((entry) => entry.surfaceId === sessionKey)).toBe(replacement);
  });

  it('does not enqueue stale review work if a new steer starts during context capture', async () => {
    const { packet, lane, sessionKey } = fixture();
    const entered = deferred<void>();
    const capture = deferred<object>();
    h.capture.mockImplementationOnce(() => { entered.resolve(); return capture.promise; });
    const completion = ingestAgentCompletionSignal(sessionKey);
    await entered.promise;
    expect((await steer(packet.id)).status).toBe(200);
    capture.resolve({});
    await completion;
    expect(getLane(lane.id)?.status).toBe('running');
    expect((await register(packet, 'afterCapture')).status).toBe(200);
    expect(dependencies.enqueueAutoReview).not.toHaveBeenCalled();
    expect(dependencies.queueReviewContinuation).not.toHaveBeenCalled();
  });

  it('still reports an evidenced read-only completion as complete', async () => {
    const { packet, lane, sessionKey } = fixture();
    packet.launchContext = { source: 'cli', presentation: 'split',
      repoContext: 'transient', workMode: 'read-only' };
    writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(),
      repoPath: lane.repoPath, packets: [packet] });
    const entered = deferred<void>();
    h.probe.mockImplementation(() => {
      entered.resolve();
      return Promise.resolve({ noChangesProduced: true });
    });
    h.capture.mockResolvedValue({ selfReview: { passed: true, decision: 'finding_ready',
      outcome: 'Inspection complete', evidence: ['Observed result'], residual: 'No changes required' } });
    const completion = ingestAgentCompletionSignal(sessionKey);
    await entered.promise;
    await vi.advanceTimersByTimeAsync(2_000);
    await completion;
    expect(getLane(lane.id)?.status).toBe('completed');
    expect(readOrchestratorControlPlaneState().packets[0]?.releaseState).toBe('released');
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
    expect(dependencies.enqueueAutoReview).not.toHaveBeenCalled();
  });

  it('does not let a delayed planning transcript park a newly steered turn', async () => {
    const { packet, lane, sessionKey } = fixture();
    packet.huddle = true;
    writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(),
      missionId: `mission-${packet.id}`, repoPath: lane.repoPath, packets: [packet] });
    const probeEntered = deferred<void>();
    h.probe.mockImplementation(() => {
      probeEntered.resolve();
      return Promise.resolve({ noChangesProduced: true });
    });
    const transcriptEntered = deferred<void>();
    const transcript = deferred<Array<{ role: string; text: string }>>();
    h.transcript.mockImplementationOnce(() => { transcriptEntered.resolve(); return transcript.promise; });
    const completion = ingestAgentCompletionSignal(sessionKey);
    await probeEntered.promise;
    await vi.advanceTimersByTimeAsync(2_000);
    await transcriptEntered.promise;
    expect((await steer(packet.id)).status).toBe(200);
    transcript.resolve([{ role: 'assistant', text: 'Implementation plan: inspect and verify.' }]);
    await completion;
    expect(getLane(lane.id)?.status).toBe('running');
    expect((await register(packet, 'afterPlan')).status).toBe(200);
    expect(readOrchestratorControlPlaneState().packets[0]?.blockedReason).not.toBe('huddle_ready');
    expect(dependencies.enqueueAutoReview).not.toHaveBeenCalled();
  });

  it('still holds a current failed turn with partial work for input', async () => {
    const { lane, sessionKey } = fixture();
    await handleAgentCompletion(sessionKey, 'failed', dependencies);
    expect(getLane(lane.id)).toMatchObject({ status: 'awaiting_input',
      lastEventLabel: 'agent_failed_work_present' });
    expect(dependencies.enqueueAutoReview).not.toHaveBeenCalled();
  });

  it('wires the server callback to this production completion path', () => {
    const source = readFileSync(join(process.cwd(), 'src/ws-server.ts'), 'utf8');
    const start = source.indexOf('async onAgentCompletion(');
    const callback = source.slice(start, source.indexOf('onAgentRetry(', start));
    expect(callback).toContain("import('@/lib/supervisor/agent-completion')");
    expect(callback).toContain('handleAgentCompletion(surfaceId, outcome, {');
    expect(callback).not.toContain('setLaneStatus(');
  });
});
