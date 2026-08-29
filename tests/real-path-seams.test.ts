/**
 * Real-path spot-checks on load-bearing seams (reachability rule).
 *
 * Each test drives the REAL entry point against PERSISTED state — not the guard
 * or helper in isolation. The seams were chosen because each currently has
 * only direct-argument coverage, each is safety/correctness-critical, and each
 * maps to an incident class the "green tests encode the premise" gap produced:
 *
 *   A. buildPacketPrompt → session-rule inheritance (#1329). The exact incident:
 *      485 green tests, yet worker inheritance was unreachable because the packet
 *      was never wired to the thread whose rules it should carry. The existing
 *      session-rules-prompt.test.ts passes a threadId to buildSessionRulesBlock
 *      DIRECTLY; it never proves buildPacketPrompt threads packet.orchestratorThreadId
 *      into that call. This asserts the whole persisted-rule → packet field →
 *      assembled prompt chain is reachable.
 *
 *   B. worker approve_and_merge raises a governance CARD instead of merging. The
 *      merge route's worker branch is the CRIT-1 moat. This drives the real route
 *      with a worker token + a persisted lane and asserts the card is actually
 *      created (a real state effect), and that the operator path does NOT get the
 *      card — proving the principal genuinely steers the branch.
 *
 *   C. the packet typecheck retry budget survives the REAL persisted round-trip
 *      (#1108). retry-budget.test.ts checks resetPacketFields in isolation; it
 *      never proves the budget survives serialization + the normalize pass every
 *      persisted read runs. This POSTs a packet through the orchestrator-state
 *      route and reads it back, exercising persist → reconcile → normalizePacket.
 *
 *   D. buildPacketPrompt → the metered-orchestrator Brain flip (Fable Slice 2,
 *      2026-07-02). Asserts the assembled dispatch prompt carries the
 *      Engineering Brain block when the ACTIVE orchestrator backend is metered
 *      (fable) even for a frontier worker (codex) — through the real
 *      operator-defaults resolution, not resolveBrainEnabledWith in isolation.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { basename, join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { TerminalStatusEvidenceDisclosure } from '@/components/desktop/TerminalStatusEvidenceRows';
import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';
import type { TypedRow } from '@/lib/cortex/qa/types';

const runtimeInventoryMock = vi.hoisted(() => ({
  agents: [] as Array<{
    sessionKey: string;
    runtime: string;
    status: string;
    currentTask?: string | null;
    lastEventAt?: string | null;
    lastActivityAt?: number | null;
    runtimeSurface?: {
      ownership?: 'provider' | 'discovered' | 'owned';
      capabilities?: { sendInput?: boolean; interrupt?: boolean };
      lifecycle?: {
        availability?: 'awaiting-thread' | 'running' | 'ready-for-resume';
        lastOutcome?: 'finished' | 'interrupted' | 'failed';
        lastRunFinishedAt?: string;
      };
    };
  }>,
  requests: [] as Array<{ fresh?: boolean } | undefined>,
}));

const authDetectMock = vi.hoisted(() => {
  class MockDispatchPreflightError extends Error {
    public readonly code = 'dispatch_cli_auth_unavailable';
    public readonly status: {
      house: 'codex' | 'claude';
      runtime: 'codex' | 'claude-code';
      installed: boolean;
      authenticated: boolean;
      detail: string;
      fix: string;
      checkedAt: number;
    };

    constructor(status: MockDispatchPreflightError['status']) {
      super(status.detail);
      this.name = 'DispatchPreflightError';
      this.status = status;
    }
  }
  return {
    unauthRuntime: null as 'codex' | 'claude-code' | null,
    DispatchPreflightError: MockDispatchPreflightError,
  };
});

vi.mock('@/lib/realtime/publisher', () => ({
  publishRealtimeMutation: vi.fn(async () => {}),
}));

vi.mock('@/lib/runtime/inventory', () => ({
  getRuntimeInventorySnapshot: vi.fn(async (options?: { fresh?: boolean }) => {
    runtimeInventoryMock.requests.push(options);
    return { agents: runtimeInventoryMock.agents };
  }),
}));

vi.mock('@/lib/runtimes/shared/auth-detect', () => ({
  DispatchPreflightError: authDetectMock.DispatchPreflightError,
  assertRuntimeDispatchable: vi.fn(async (runtime: 'codex' | 'claude-code') => {
    if (authDetectMock.unauthRuntime !== runtime) return;
    const house = runtime === 'codex' ? 'codex' : 'claude';
    throw new authDetectMock.DispatchPreflightError({
      house,
      runtime,
      installed: true,
      authenticated: false,
      detail: `${house === 'codex' ? 'Codex' : 'Claude Code'} CLI is installed but not signed in.`,
      fix: house === 'codex' ? 'Run `codex login`.' : 'Run `claude` once to sign in.',
      checkedAt: Date.now(),
    });
  }),
  getRuntimeAuthSnapshot: vi.fn(async () => ({
    statuses: {
      codex: { house: 'codex', runtime: 'codex', installed: true, authenticated: true, detail: 'Codex ready.', fix: 'Run `codex login`.', checkedAt: Date.now() },
      claude: { house: 'claude', runtime: 'claude-code', installed: true, authenticated: true, detail: 'Claude ready.', fix: 'Run `claude` once to sign in.', checkedAt: Date.now() },
    },
    suggestedSubscriptionProfile: { profile: null, detail: null },
  })),
}));

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-real-path-seams-'));
const tempDirs: string[] = [];
const WORKER_TOKEN = 'local-worker-token-seambeef0123456789abcd';
const WS_TOKEN = 'operator-ws-token-seam-0123456789abcdef';
writeFileSync(join(dataDir, 'worker-token'), `${WORKER_TOKEN}\n`, 'utf-8');
writeFileSync(join(dataDir, 'ws-token'), `${WS_TOKEN}\n`, 'utf-8');
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
const { buildPacketPrompt } = await import('@/lib/orchestrator/packet-prompt');
const { addSessionRule } = await import('@/lib/db/session-rules-store');
const mergeRoute = await import('@/app/api/orchestrator/merge/route');
const mergePreviewRoute = await import('@/app/api/orchestrator/merge-preview/route');
const stateRoute = await import('@/app/api/orchestrator/state/route');
const operatorStatusRoute = await import('@/app/api/operator/status/route');
const createMissionRoute = await import('@/app/api/orchestrator/create-mission/route');
const chatHistoryRoute = await import('@/app/api/v2/chat-history/route');
const searchRoute = await import('@/app/api/panel/search/route');
const { archiveLane, createLane, findLaneByPacket, getLane, getLaneEvents, setLaneStatus, updateLane } = await import('@/lib/lane/registry');
const { dispatch } = await import('@/lib/lane/commands');
const { listApprovalsForContext } = await import('@/lib/approvals/store');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const {
  readOrchestratorControlPlaneState,
  withControlPlaneLock,
  writeOrchestratorControlPlaneState,
} = await import('@/lib/orchestrator/control-plane');
const { MISSION_CREATE_LOCK_WAIT_MS } = await import('@/lib/orchestrator/operator-mission-service/mission');
const { sweepPacketsMergedByAncestry } = await import('@/lib/orchestrator/merged-by-ancestry');
const { getMissionStatus, approveAndMergePacket, submitPacketReview } = await import('@/lib/orchestrator/operator-mission-service');
const { recordMission } = await import('@/lib/db/missions-store');
const { getSqlite } = await import('@/lib/db');
const { mintPacketWorkerToken } = await import('@/lib/auth/packet-worker-token');
const { syncTranscriptSearchDocument } = await import('@/lib/search/transcripts');
const { getActiveProjectScopeForRepo } = await import('@/lib/repos/projects');
const {
  resetRecallCacheForTests,
  seedRecallCacheForTests,
  setRecallDependenciesForTests,
} = await import('@/lib/cortex/qa/recall');
const {
  runChatHistorySearchBackfill,
  runPacketTranscriptSearchBackfill,
} = await import('@/lib/search/backfill');
const { prepareLaunchWorktree } = await import('@/lib/worktree/launch');
const { enforceWedgeTimeouts, WEDGE_AWAITING_ORCHESTRATOR_MS } = await import('@/lib/lane/wedge-timeouts');
const { listInboxItems } = await import('@/lib/supervisor/inbox');
const {
  markRalphRetryRequeued,
  resolvePostCompletionPacket,
  transitionPostCompletionLaneToReviewing,
} = await import('@/lib/supervisor/post-completion-packet');

afterEach(() => {
  runtimeInventoryMock.agents = [];
  runtimeInventoryMock.requests = [];
  authDetectMock.unauthRuntime = null;
  resetRecallCacheForTests();
  rmSync(join(dataDir, 'operator-defaults.json'), { force: true });
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function packetFixture(overrides: Partial<OrchestratorPacket> = {}): OrchestratorPacket {
  return {
    id: 'pkt-seam-1',
    referenceLabel: 'PKT-1',
    title: 'feat wire the thing',
    summary: 'Do the thing.',
    status: 'draft',
    queueState: 'queued',
    releaseState: 'pending',
    blockedReason: null,
    lane: null,
    review: null,
    runtime: 'codex',
    dependencyPacketIds: [],
    dependencyLabels: [],
    attemptCount: 0,
    lastEventAt: '2026-07-02T00:00:00.000Z',
    lastEventLabel: 'created',
    recoveryCount: 0,
    typecheckAutoRetries: 0,
    orchestratorThreadId: null,
    ...overrides,
  } as OrchestratorPacket;
}

// ── Seam A — session-rule inheritance flows through buildPacketPrompt (#1329) ──

describe('seam A — buildPacketPrompt carries the thread session rules into the worker prompt', () => {
  it('a persisted rule on the packet thread appears in the assembled dispatch prompt', async () => {
    const threadId = 'thoughts-seam-A-1';
    addSessionRule(threadId, 'DEPRIORITIZE SPEED — correctness over throughput');

    const prompt = await buildPacketPrompt(
      packetFixture({ id: 'pkt-seam-A-1', orchestratorThreadId: threadId }),
      [],
    );

    // The whole chain is reachable: persisted rule → packet.orchestratorThreadId
    // → buildSessionRulesBlock → assembled prompt. This is exactly what #1329
    // proved unreachable despite green isolation tests.
    expect(prompt).toContain('Operator session rules (binding)');
    expect(prompt).toContain('DEPRIORITIZE SPEED — correctness over throughput');
  });

  it('a packet with no thread (or a thread with no rules) carries NO rules block (negative control)', async () => {
    const prompt = await buildPacketPrompt(
      packetFixture({ id: 'pkt-seam-A-2', orchestratorThreadId: null }),
      [],
    );
    expect(prompt).not.toContain('Operator session rules (binding)');
  });
});

// ── Seam B — worker merge raises a governance card, not a merge ──────────────

function workerReq(url: string, body: unknown, token = WORKER_TOKEN): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: { host: 'localhost:3001', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}
function operatorReq(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: { host: 'localhost:3001' },
    body: JSON.stringify(body && typeof body === 'object'
      ? { clientMutationId: `real-path-${crypto.randomUUID()}`, ...body }
      : body),
  });
}
function operatorGet(url: string): NextRequest {
  return new NextRequest(url, { method: 'GET', headers: { host: 'localhost:3001' } });
}

describe('seam B — a dispatched worker approve_and_merge raises an operator card (CRIT-1/HIGH-4)', () => {
  const url = 'http://localhost:3001/api/orchestrator/merge';

  it('worker principal → merged:false, pending_operator_approval, and a real card is persisted', async () => {
    const packetId = 'pkt-seam-B-worker';
    const lane = createLane({ repoPath: '/tmp/o8-seam-repo', branch: 'inline/seam-b', runtime: 'codex', packetId });
    expect(findLaneByPacket(packetId)?.id).toBe(lane.id);

    const res = await mergeRoute.POST(workerReq(url, { packetId }, mintPacketWorkerToken(packetId)));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.result.merged).toBe(false);
    expect(json.result.status).toBe('pending_operator_approval');

    // Real state effect: the governance card actually exists in the queue.
    const cards = listApprovalsForContext({ laneId: lane.id }).filter((a) => a.status === 'pending');
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.some((c) => c.policyRuleId === 'worker-merge-governance')).toBe(true);
  });

  it('operator principal on a packet with no lane → NOT the worker card path (404 lane-agnostic direct-merge branch)', async () => {
    // The operator never takes the worker-card branch — with no lane it falls
    // through to the real merge, which fails on the missing packet (not a card).
    const res = await mergeRoute.POST(operatorReq(url, { packetId: 'pkt-seam-B-nolane-operator' }));
    const json = await res.json();
    expect(json.ok).toBe(false);
    // Whatever the failure, it is NOT the worker "pending_operator_approval" card.
    expect(json.result?.status).not.toBe('pending_operator_approval');
  });
});

// ── Seam C — retry budget survives the real persisted round-trip (#1108) ─────

describe('seam C — typecheckAutoRetries survives the orchestrator-state persist → read round-trip', () => {
  const url = 'http://localhost:3001/api/orchestrator/state';

  it('a packet POSTed with a retry budget reads back with the budget intact', async () => {
    // Read the server's current mission first — mission IDENTITY is server-owned
    // (#596), so a POST with a mismatched missionId is dropped as stale. Adopt the
    // server id and append our packet, exactly how the browser reconcile POSTs.
    const seedReq = new NextRequest(url, { method: 'GET', headers: { host: 'localhost:3001' } });
    const seed = await (await stateRoute.GET(seedReq)).json();
    const current: OrchestratorMissionState = seed.mission ?? createEmptyOrchestratorMissionState();

    const mission: OrchestratorMissionState = {
      ...current,
      packets: [
        ...current.packets,
        packetFixture({ id: 'pkt-seam-C', typecheckAutoRetries: 2, recoveryCount: 3 }),
      ],
    };

    // Real persistence entry point: POST persists under the control-plane lock.
    const postRes = await stateRoute.POST(operatorReq(url, { mission }));
    expect(postRes.status).toBe(200);

    // Real read entry point: GET reconciles + normalizes the persisted state.
    const getReq = new NextRequest(url, { method: 'GET', headers: { host: 'localhost:3001' } });
    const getRes = await stateRoute.GET(getReq);
    expect(getRes.status).toBe(200);
    const json = await getRes.json();
    const packet = json.mission.packets.find((p: OrchestratorPacket) => p.id === 'pkt-seam-C');

    // The budget rides on the PACKET precisely so it survives redispatch. If the
    // normalize pass drops it (the normalizePacket-drops-fields trap), a
    // type-broken packet loops full workers forever — this asserts it persists.
    expect(packet).toBeTruthy();
    expect(packet.typecheckAutoRetries).toBe(2);
  });
});

// ── Seam E — mission create bounds the dispatch-held state lock ─────────────

describe('seam E — create-mission fails loudly when dispatch holds the mission store lock', () => {
  const url = 'http://localhost:3001/api/orchestrator/create-mission';

  it('returns mission_store_busy within the acquisition bound instead of hanging', async () => {
    const beforeMissionId = readOrchestratorControlPlaneState().missionId;
    const beforeMissionRows = (getSqlite().prepare('SELECT COUNT(*) AS count FROM missions').get() as { count: number }).count;
    let releaseHolder!: () => void;
    let markHolderReady!: () => void;
    const holderReady = new Promise<void>((resolve) => {
      markHolderReady = resolve;
    });
    const holder = withControlPlaneLock(async () => {
      markHolderReady();
      await new Promise<void>((resolve) => {
        releaseHolder = resolve;
      });
    });
    await holderReady;

    const originalSetTimeout = globalThis.setTimeout.bind(globalThis);
    const lockTimeoutControl: { trigger?: () => void } = {};
    let markTimeoutScheduled!: () => void;
    const timeoutScheduled = new Promise<void>((resolve) => {
      markTimeoutScheduled = resolve;
    });
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((...args) => {
      const timer = originalSetTimeout(...args);
      const [handler, delay] = args;
      if (delay === MISSION_CREATE_LOCK_WAIT_MS && typeof handler === 'function') {
        lockTimeoutControl.trigger = () => handler();
        markTimeoutScheduled();
      }
      return timer;
    });

    try {
      const responsePromise = createMissionRoute.POST(operatorReq(url, {
        repoPath: process.cwd(),
        issues: [{
          number: 90_146_600,
          title: 'bound mission create lock wait',
          body: 'Exercise the real route while dispatch owns the control-plane lock.',
          url: '',
        }],
      }));
      await Promise.race([
        timeoutScheduled,
        new Promise<never>((_, reject) => {
          originalSetTimeout(() => reject(new Error('mission-create lock timeout was not scheduled')), 5_000);
        }),
      ]);

      const startedAt = performance.now();
      if (!lockTimeoutControl.trigger) {
        throw new Error('mission-create lock timeout callback was not captured');
      }
      lockTimeoutControl.trigger();
      const res = await responsePromise;
      expect(performance.now() - startedAt).toBeLessThan(1_000);
      expect(res.status).toBe(503);
      await expect(res.json()).resolves.toEqual({
        ok: false,
        error: {
          code: 'mission_store_busy',
          message: 'Mission store is busy dispatching — retry in a moment.',
        },
      });
      expect(readOrchestratorControlPlaneState().missionId).toBe(beforeMissionId);
      const afterMissionRows = (getSqlite().prepare('SELECT COUNT(*) AS count FROM missions').get() as { count: number }).count;
      expect(afterMissionRows).toBe(beforeMissionRows);
    } finally {
      timeoutSpy.mockRestore();
      releaseHolder();
      await holder;
    }
  });
});

// ── Seam F — omitted mission runtime keeps the explicit production default ─

describe('seam F — create-mission runtime policy reaches persisted packets', () => {
  const url = 'http://localhost:3001/api/orchestrator/create-mission';

  it('no explicit worker choice keeps Codex as the production default', async () => {
    writeFileSync(
      join(dataDir, 'operator-defaults.json'),
      `${JSON.stringify({ orchestratorBackend: 'codex', inAppOrchestratorEnabled: false }, null, 2)}\n`,
      'utf-8',
    );

    const res = await createMissionRoute.POST(operatorReq(url, {
      repoPath: process.cwd(),
      requestedEffort: 'high',
      issues: [{
        number: 90_000_123,
        title: 'dispatch default seam',
        body: 'No runtime is specified by the caller.',
        url: '',
      }],
    }));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.ok).toBe(true);
    const state = await (await stateRoute.GET(operatorGet('http://localhost:3001/api/orchestrator/state'))).json();
    const packet = state.mission.packets.find((p: OrchestratorPacket) => p.id === json.result.packets[0].id);
    expect(packet.runtime).toBe('codex');
    expect(packet.workerRouting.selectedRuntime).toBe('codex');
    expect(packet.workerRouting.enforcement).toBe('dispatchable_runtimes');
    expect(packet.workerRouting.requestedEffort).toBe('high');
    expect(packet.workerRouting.selectedEffort).toBe('high');
  });

  it('subscriptionProfile=claude-only starts its worker autonomously by default', async () => {
    writeFileSync(
      join(dataDir, 'operator-defaults.json'),
      `${JSON.stringify({ subscriptionProfile: 'claude-only' }, null, 2)}\n`,
      'utf-8',
    );

    const res = await createMissionRoute.POST(operatorReq(url, {
      repoPath: process.cwd(),
      issues: [{
        number: 90_000_124,
        title: 'dispatch claude-only profile seam',
        body: 'No runtime is specified by the caller.',
        url: '',
      }],
    }));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.ok).toBe(true);
    const state = await (await stateRoute.GET(operatorGet('http://localhost:3001/api/orchestrator/state'))).json();
    const packet = state.mission.packets.find((p: OrchestratorPacket) => p.id === json.result.packets[0].id);
    expect(packet.runtime).toBe('claude-code');
    expect(packet.workerRouting.selectedRuntime).toBe('claude-code');
    expect(packet.workerRouting.selectedModel).toBe('claude-sonnet-5');
    expect(packet.assignedModel).toBe('claude-sonnet-5');
    expect(packet.huddle).toBe(false);

    const prompt = await buildPacketPrompt(packet, state.mission.packets);
    expect(prompt).not.toContain('Huddle mode (this packet)');
    expect(prompt).not.toContain('Advisor discipline (single-sub cheap-tier worker)');
    expect(prompt).toContain('Engineering Brain available');
  });

  it('workerStartMode=adaptive keeps cheap-tier alignment available as an explicit preference', async () => {
    writeFileSync(
      join(dataDir, 'operator-defaults.json'),
      `${JSON.stringify({ subscriptionProfile: 'claude-only', workerStartMode: 'adaptive' }, null, 2)}\n`,
      'utf-8',
    );

    const res = await createMissionRoute.POST(operatorReq(url, {
      repoPath: process.cwd(),
      issues: [{
        number: 90_000_130,
        title: 'dispatch adaptive start seam',
        body: 'The operator selected adaptive worker starts.',
        url: '',
      }],
    }));
    expect(res.status).toBe(201);
    const json = await res.json();
    const state = await (await stateRoute.GET(operatorGet('http://localhost:3001/api/orchestrator/state'))).json();
    const packet = state.mission.packets.find((candidate: OrchestratorPacket) => candidate.id === json.result.packets[0].id);
    expect(packet.huddle).toBe(true);
    expect(await buildPacketPrompt(packet, state.mission.packets)).toContain('Huddle mode (this packet)');
  });

  it('subscriptionProfile=both does not replace the Codex fallback', async () => {
    writeFileSync(
      join(dataDir, 'operator-defaults.json'),
      `${JSON.stringify({ subscriptionProfile: 'both', orchestratorBackend: 'codex', inAppOrchestratorEnabled: false }, null, 2)}\n`,
      'utf-8',
    );

    const res = await createMissionRoute.POST(operatorReq(url, {
      repoPath: process.cwd(),
      issues: [{
        number: 90_000_125,
        title: 'dispatch both profile seam',
        body: 'No runtime is specified by the caller.',
        url: '',
      }],
    }));
    expect(res.status).toBe(201);
    const json = await res.json();
    const state = await (await stateRoute.GET(operatorGet('http://localhost:3001/api/orchestrator/state'))).json();
    const packet = state.mission.packets.find((p: OrchestratorPacket) => p.id === json.result.packets[0].id);
    expect(packet.workerRouting.selectedRuntime).toBe('codex');
    expect(packet.workerRouting.selectedModel).toBeNull();
    expect(packet.huddle).toBe(false);
  });

  it('subscriptionProfile=claude-only honors explicit huddle:false', async () => {
    writeFileSync(
      join(dataDir, 'operator-defaults.json'),
      `${JSON.stringify({ subscriptionProfile: 'claude-only' }, null, 2)}\n`,
      'utf-8',
    );

    const res = await createMissionRoute.POST(operatorReq(url, {
      repoPath: process.cwd(),
      huddle: false,
      issues: [{
        number: 90_000_128,
        title: 'dispatch claude-only no huddle seam',
        body: 'Caller explicitly opted out.',
        url: '',
      }],
    }));
    expect(res.status).toBe(201);
    const json = await res.json();
    const state = await (await stateRoute.GET(operatorGet('http://localhost:3001/api/orchestrator/state'))).json();
    const packet = state.mission.packets.find((p: OrchestratorPacket) => p.id === json.result.packets[0].id);
    expect(packet.workerRouting.selectedModel).toBe('claude-sonnet-5');
    expect(packet.huddle).toBe(false);
  });

  it('subscriptionProfile=claude-only rejects an explicit Codex request clearly', async () => {
    writeFileSync(
      join(dataDir, 'operator-defaults.json'),
      `${JSON.stringify({ subscriptionProfile: 'claude-only' }, null, 2)}\n`,
      'utf-8',
    );

    const res = await createMissionRoute.POST(operatorReq(url, {
      repoPath: process.cwd(),
      requestedRuntime: 'codex',
      issues: [{
        number: 90_000_126,
        title: 'dispatch incompatible profile seam',
        body: 'Runtime is explicitly unavailable under the profile.',
        url: '',
      }],
    }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe('subscription_profile_runtime_unavailable');
    expect(json.error.message).toContain('subscriptionProfile "claude-only"');
  });

  it('subscriptionProfile=claude-only rejects an issue-level Codex runtime pin clearly', async () => {
    writeFileSync(
      join(dataDir, 'operator-defaults.json'),
      `${JSON.stringify({ subscriptionProfile: 'claude-only' }, null, 2)}\n`,
      'utf-8',
    );

    const res = await createMissionRoute.POST(operatorReq(url, {
      repoPath: process.cwd(),
      issues: [{
        number: 90_000_127,
        title: 'dispatch incompatible issue runtime seam',
        body: 'Runtime is pinned on the issue object.',
        url: '',
        runtime: 'codex',
      }],
    }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe('subscription_profile_runtime_unavailable');
    expect(json.error.message).toContain('subscriptionProfile "claude-only"');
  });

  it('subscriptionProfile=codex-only still dispatches an explicitly selected provider runtime', async () => {
    writeFileSync(
      join(dataDir, 'operator-defaults.json'),
      `${JSON.stringify({ subscriptionProfile: 'codex-only' }, null, 2)}\n`,
      'utf-8',
    );

    const res = await createMissionRoute.POST(operatorReq(url, {
      repoPath: process.cwd(),
      requestedRuntime: 'opencode',
      requestedModel: 'openrouter/deepseek/deepseek-v4-flash',
      issues: [{
        number: 90_000_129,
        title: 'dispatch provider runtime under codex profile',
        body: 'The provider runtime owns its authentication and billing.',
        url: '',
      }],
    }));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.ok).toBe(true);
    const state = await (await stateRoute.GET(operatorGet('http://localhost:3001/api/orchestrator/state'))).json();
    const packet = state.mission.packets.find((candidate: OrchestratorPacket) => candidate.id === json.result.packets[0].id);
    expect(packet.runtime).toBe('opencode');
    expect(packet.workerRouting.selectedRuntime).toBe('opencode');
    expect(packet.workerRouting.selectedModel).toBe('openrouter/deepseek/deepseek-v4-flash');
    expect(packet.huddle).toBe(false);
  });

  it('codex unauthenticated fails preflight before creating a mission', async () => {
    authDetectMock.unauthRuntime = 'codex';
    const before = await (await stateRoute.GET(operatorGet('http://localhost:3001/api/orchestrator/state'))).json();
    const beforeMissionId = before.mission?.missionId ?? null;

    const res = await createMissionRoute.POST(operatorReq(url, {
      repoPath: process.cwd(),
      requestedRuntime: 'codex',
      issues: [{
        number: 90_000_128,
        title: 'dispatch auth preflight seam',
        body: 'Codex is selected but not signed in.',
        url: '',
      }],
    }));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe('dispatch_cli_auth_unavailable');
    expect(json.error.message).toContain('Run `codex login`');
    const after = await (await stateRoute.GET(operatorGet('http://localhost:3001/api/orchestrator/state'))).json();
    expect(after.mission?.missionId ?? null).toBe(beforeMissionId);
  });
});

// ── Seam D — metered orchestrator flips the Brain on through the REAL prompt ─

describe('seam D — a metered orchestrator (fable) puts the Brain in a frontier worker prompt', () => {
  // Fable mode, Slice 2 (2026-07-02): under a per-token-metered orchestrator,
  // workers must self-serve repo knowledge via the fixed-cost Brain instead of
  // routing questions back through the metered window. The isolation-test trap
  // (#1329): asserting resolveBrainEnabledWith(…, 'fable') proves nothing about
  // whether the dispatch chain actually reaches it — so this drives the real
  // buildPacketPrompt against the persisted operator-defaults resolution
  // (O8_ORCHESTRATOR_BACKEND env layer) and asserts the assembled prompt.
  const withBackend = async (backend: string, fn: () => Promise<void>) => {
    process.env.O8_ORCHESTRATOR_BACKEND = backend;
    try {
      await fn();
    } finally {
      delete process.env.O8_ORCHESTRATOR_BACKEND;
    }
  };

  it('backend=fable: a codex (frontier) packet prompt carries the Brain section in auto mode', async () => {
    await withBackend('fable', async () => {
      const prompt = await buildPacketPrompt(packetFixture({ id: 'pkt-seam-D-1' }), []);
      expect(prompt).toContain('Engineering Brain available');
    });
  });

  it('backend=codex (subscription): the same packet stays lean (negative control)', async () => {
    await withBackend('codex', async () => {
      const prompt = await buildPacketPrompt(packetFixture({ id: 'pkt-seam-D-2' }), []);
      expect(prompt).not.toContain('Engineering Brain available');
    });
  });

  it('backend=fable + explicit useBrain:false: the per-packet override still wins', async () => {
    await withBackend('fable', async () => {
      const prompt = await buildPacketPrompt(
        packetFixture({ id: 'pkt-seam-D-3', useBrain: false }),
        [],
      );
      expect(prompt).not.toContain('Engineering Brain available');
    });
  });
});

// ── Seam E — reviewing projection consumes active-run liveness (#1366) ──────

describe('seam E — review-ready projection is suppressed while owned Codex is still active', () => {
  const url = 'http://localhost:3001/api/orchestrator/state';

  it('real state GET maps a reviewing lane back to running when runtime truth says active owned run', async () => {
    const packetId = 'pkt-seam-E-active-reviewing';
    const surfaceId = 'codex-owned:seam-E-active';
    const repoPath = mkdtempSync(join(os.tmpdir(), 'o8-seam-E-repo-'));
    tempDirs.push(repoPath);

    const lane = createLane({
      repoPath,
      worktreePath: repoPath,
      branch: 'inline/seam-e',
      runtime: 'codex',
      packetId,
      sessionKey: surfaceId,
    });
    setLaneStatus(lane.id, 'reviewing', 'system', 'review_ready');

    runtimeInventoryMock.agents = [{
      sessionKey: surfaceId,
      runtime: 'codex',
      status: 'running',
      currentTask: 'Editing files',
      lastEventAt: new Date().toISOString(),
      runtimeSurface: {
        ownership: 'owned',
        capabilities: { sendInput: false, interrupt: true },
        lifecycle: { availability: 'running' },
      },
    }];

    const seed = await (await stateRoute.GET(operatorGet(url))).json();
    const current: OrchestratorMissionState = seed.mission ?? createEmptyOrchestratorMissionState();
    const mission: OrchestratorMissionState = {
      ...current,
      packets: [
        ...current.packets,
        packetFixture({ id: packetId, status: 'awaiting_review', lane: null }),
      ],
    };
    const postRes = await stateRoute.POST(operatorReq(url, { mission }));
    expect(postRes.status).toBe(200);

    const getRes = await stateRoute.GET(operatorGet(url));
    expect(getRes.status).toBe(200);
    const json = await getRes.json();
    const packet = json.mission.packets.find((p: OrchestratorPacket) => p.id === packetId);

    expect(packet).toBeTruthy();
    expect(packet.status).toBe('running');
    expect(packet.status).not.toBe('awaiting_review');
  });

  it('real state GET keeps lane review-ready authoritative after the owned run finishes', async () => {
    const packetId = 'pkt-seam-E-finished-reviewing';
    const surfaceId = 'codex-owned:seam-E-finished';
    const repoPath = mkdtempSync(join(os.tmpdir(), 'o8-seam-E-finished-repo-'));
    const finishedAt = '2026-08-29T12:10:00.000Z';
    tempDirs.push(repoPath);

    const lane = createLane({
      repoPath,
      worktreePath: repoPath,
      branch: 'inline/seam-e-finished',
      runtime: 'codex',
      packetId,
      sessionKey: surfaceId,
    });
    setLaneStatus(lane.id, 'reviewing', 'system', 'review_ready');

    runtimeInventoryMock.agents = [{
      sessionKey: surfaceId,
      runtime: 'codex',
      status: 'completed',
      currentTask: 'Worker finished and awaits review',
      lastEventAt: finishedAt,
      runtimeSurface: {
        ownership: 'owned',
        capabilities: { sendInput: false, interrupt: false },
        lifecycle: {
          availability: 'ready-for-resume',
          lastOutcome: 'finished',
          lastRunFinishedAt: finishedAt,
        },
      },
    }];

    const seed = await (await stateRoute.GET(operatorGet(url))).json();
    const current: OrchestratorMissionState = seed.mission ?? createEmptyOrchestratorMissionState();
    const mission: OrchestratorMissionState = {
      ...current,
      packets: [
        ...current.packets,
        packetFixture({ id: packetId, status: 'awaiting_review', lane: null }),
      ],
    };
    const postRes = await stateRoute.POST(operatorReq(url, { mission }));
    expect(postRes.status).toBe(200);

    const getRes = await stateRoute.GET(operatorGet(url));
    expect(getRes.status).toBe(200);
    const json = await getRes.json();
    const packet = json.mission.packets.find((candidate: OrchestratorPacket) => candidate.id === packetId);
    const agent = json.agents.find((candidate: { sessionKey: string }) => candidate.sessionKey === surfaceId);

    expect(packet.status).toBe('awaiting_review');
    expect(agent.status).toBe('reviewing');
    expect(agent.statusEvidence).toMatchObject({
      state: 'review-ready',
      authority: 'lane-state',
    });
    expect(agent.statusEvidence).not.toHaveProperty('fallbackReason');
    expect(agent.statusEvidence.evidence).toContainEqual({
      source: 'runtime-session.status',
      value: 'completed',
    });
    expect(packet.statusEvidence).toEqual(agent.statusEvidence);
  });
});

describe('seam E — orchestrator state projects one terminal status authority', () => {
  const url = 'http://localhost:3001/api/orchestrator/state';

  it('real state GET resolves lane evidence for a parked packet with no inventory agent', async () => {
    const packetId = 'pkt-seam-E-lane-only-blocked';
    const surfaceId = 'codex-owned:seam-E-lane-only-blocked';
    const repoPath = mkdtempSync(join(os.tmpdir(), 'o8-seam-E-lane-only-repo-'));
    tempDirs.push(repoPath);

    const persistedLane = createLane({
      repoPath,
      worktreePath: repoPath,
      branch: 'inline/seam-e-lane-only',
      runtime: 'codex',
      packetId,
      sessionKey: surfaceId,
    });
    setLaneStatus(
      persistedLane.id,
      'awaiting_orchestrator',
      'system',
      'worktree_missing_unverified',
    );
    runtimeInventoryMock.agents = [];

    const seed = await (await stateRoute.GET(operatorGet(url))).json();
    const current: OrchestratorMissionState = seed.mission ?? createEmptyOrchestratorMissionState();
    const mission: OrchestratorMissionState = {
      ...current,
      packets: [
        ...current.packets,
        packetFixture({ id: packetId, status: 'blocked', lane: null }),
      ],
    };
    const postRes = await stateRoute.POST(operatorReq(url, { mission }));
    expect(postRes.status).toBe(200);

    const response = await stateRoute.GET(operatorGet(url));
    expect(response.status).toBe(200);
    const json = await response.json();
    const packet = json.mission.packets.find((candidate: OrchestratorPacket) => (
      candidate.id === packetId
    ));

    expect(json.agents).toEqual([]);
    expect(packet.statusEvidence).toMatchObject({
      sessionId: surfaceId,
      runtime: 'codex',
      state: 'blocked',
      authority: 'lane-state',
    });
    expect(packet.statusEvidence.summary).toContain('worktree_missing_unverified');
    expect(packet.statusEvidence.evidence).toContainEqual({
      source: 'lane-event:worktree_missing_unverified',
      value: expect.stringContaining('awaiting_orchestrator'),
    });
    expect(runtimeInventoryMock.requests.at(-1)).toEqual({ fresh: false });
  });

  it('real state GET carries resolved evidence from fabricated inventory to the desktop status rows', async () => {
    const packetId = 'pkt-seam-E-status-evidence';
    const surfaceId = 'codex-owned:seam-E-status-evidence';
    const repoPath = mkdtempSync(join(os.tmpdir(), 'o8-seam-E-status-repo-'));
    tempDirs.push(repoPath);

    const persistedLane = createLane({
      repoPath,
      worktreePath: repoPath,
      branch: 'inline/seam-e-status',
      runtime: 'codex',
      packetId,
      sessionKey: surfaceId,
    });
    setLaneStatus(persistedLane.id, 'running', 'system', 'session_running');

    runtimeInventoryMock.agents = [{
      sessionKey: surfaceId,
      runtime: 'codex',
      status: 'failed',
      currentTask: 'Runtime exited while lane remained active',
      lastEventAt: '2026-08-29T12:00:00.000Z',
      runtimeSurface: {
        ownership: 'owned',
        capabilities: { sendInput: false, interrupt: false },
        lifecycle: { availability: 'ready-for-resume' },
      },
    }];

    const response = await stateRoute.GET(operatorGet(url));
    expect(response.status).toBe(200);
    const json = await response.json();
    const agent = json.agents.find((candidate: { sessionKey: string }) => candidate.sessionKey === surfaceId);

    expect(agent.status).toBe('failed');
    expect(agent.statusEvidence).toMatchObject({
      sessionId: surfaceId,
      runtime: 'codex',
      state: 'failed',
      authority: 'runtime-event',
      observedAt: '2026-08-29T12:00:00.000Z',
    });
    expect(agent.statusEvidence.evidence).toContainEqual({
      source: `lane:${persistedLane.id}.status`,
      value: 'running',
    });
    const desktopMarkup = renderToStaticMarkup(createElement(TerminalStatusEvidenceDisclosure, {
      evidence: agent.statusEvidence,
      defaultExpanded: true,
    }));
    expect(desktopMarkup).toContain('failed · runtime');
    expect(desktopMarkup).toContain(`lane:${persistedLane.id}.status`);
    expect(runtimeInventoryMock.requests.at(-1)).toEqual({ fresh: false });
  });

  it('real state GET keeps cloud and remote-customer sessions with TerminalStatusEvidence', async () => {
    runtimeInventoryMock.agents = ['cloud', 'remote-customer'].map((runtime, index) => ({
      sessionKey: `${runtime}-owned:seam-E-status-evidence`,
      runtime,
      status: 'running',
      currentTask: `Running on registered ${runtime} worker`,
      lastEventAt: `2026-08-29T12:0${5 + index}:00.000Z`,
      runtimeSurface: {
        ownership: 'owned' as const,
        capabilities: { sendInput: false, interrupt: true },
        lifecycle: { availability: 'running' as const },
      },
    }));

    const response = await stateRoute.GET(operatorGet(url));
    expect(response.status).toBe(200);
    const json = await response.json();
    for (const runtime of ['cloud', 'remote-customer']) {
      const sessionId = `${runtime}-owned:seam-E-status-evidence`;
      const agent = json.agents.find((candidate: { sessionKey: string }) => candidate.sessionKey === sessionId);
      expect(agent).toBeTruthy();
      expect(agent.runtime).toBe(runtime);
      expect(agent.statusEvidence).toMatchObject({
        sessionId,
        runtime,
        state: 'working',
        authority: 'runtime-event',
      });
    }
  });

  it('real operator status GET keeps cloud and remote-customer sessions', async () => {
    runtimeInventoryMock.agents = ['cloud', 'remote-customer'].map((runtime) => ({
      sessionKey: `${runtime}-owned:operator-status`,
      runtime,
      status: 'running',
      currentTask: `Running on registered ${runtime} worker`,
      lastEventAt: '2026-08-29T12:05:00.000Z',
      runtimeSurface: {
        ownership: 'owned' as const,
        capabilities: { sendInput: false, interrupt: true },
        lifecycle: { availability: 'running' as const },
      },
    }));

    const response = await operatorStatusRoute.GET(operatorGet('http://localhost:3001/api/operator/status'));
    expect(response.status).toBe(200);
    const json = await response.json();

    expect(json.agents.map((candidate: { runtime: string }) => candidate.runtime)).toEqual([
      'cloud',
      'remote-customer',
    ]);
    expect(json.agents.map((candidate: { statusEvidence: { runtime: string } }) => (
      candidate.statusEvidence.runtime
    ))).toEqual(['cloud', 'remote-customer']);
  });

  it('real state GET returns 200 and preserves peers when one observation time is invalid', async () => {
    const invalidSessionId = 'remote-customer-owned:invalid-time';
    const healthySessionId = 'cloud-owned:healthy-time';
    runtimeInventoryMock.agents = [
      {
        sessionKey: invalidSessionId,
        runtime: 'remote-customer',
        status: 'running',
        currentTask: 'Waiting for a valid observation',
        lastEventAt: 'not-a-time',
        lastActivityAt: null,
      },
      {
        sessionKey: healthySessionId,
        runtime: 'cloud',
        status: 'running',
        currentTask: 'Healthy registered runtime session',
        lastEventAt: '2026-08-29T12:08:00.000Z',
      },
    ];

    const response = await stateRoute.GET(operatorGet(url));
    expect(response.status).toBe(200);
    const json = await response.json();
    const invalid = json.agents.find((candidate: { sessionKey: string }) => (
      candidate.sessionKey === invalidSessionId
    ));

    expect(json.agents.map((candidate: { sessionKey: string }) => candidate.sessionKey)).toEqual([
      invalidSessionId,
      healthySessionId,
    ]);
    expect(invalid.statusEvidence).toMatchObject({
      sessionId: invalidSessionId,
      runtime: 'remote-customer',
      state: 'unknown',
      authority: 'raw-terminal',
      summary: 'No observation with a valid time was available.',
      evidence: [],
    });
    expect(Date.parse(invalid.statusEvidence.observedAt)).not.toBeNaN();
  });

  it('keeps precedence code in the terminal status resolver instead of the old call sites', () => {
    const inventorySource = readFileSync(
      join(process.cwd(), 'src/lib/runtime/inventory.ts'),
      'utf-8',
    );
    const operatorStatusSource = readFileSync(
      join(process.cwd(), 'src/lib/orchestrator/operator-status-model.ts'),
      'utf-8',
    );

    expect(inventorySource).not.toContain('const statusWeight');
    expect(operatorStatusSource).not.toContain('packetStatusFromLaneStatus');
    expect(inventorySource).toContain('resolveTerminalStatusEvidence');
    expect(operatorStatusSource).toContain('resolveTerminalStatusEvidence');
  });
});

// ── Seam F — merge preview re-checks clean tree at read time (#1366/#1363) ───

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function makeDirtyGitRepo(): string {
  const repoPath = mkdtempSync(join(os.tmpdir(), 'o8-seam-F-repo-'));
  tempDirs.push(repoPath);
  git(repoPath, ['init', '-b', 'main']);
  writeFileSync(join(repoPath, 'tracked.txt'), 'base\n');
  git(repoPath, ['add', 'tracked.txt']);
  git(repoPath, ['-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', 'commit', '-m', 'base']);
  git(repoPath, ['checkout', '-b', 'inline/seam-f']);
  writeFileSync(join(repoPath, 'tracked.txt'), 'moving target\n');
  return repoPath;
}

function gitOut(cwd: string, args: string[]): string {
  return git(cwd, args).trim();
}

function makeMergeRepo(prefix: string): string {
  const repoPath = mkdtempSync(join(os.tmpdir(), prefix));
  const originPath = mkdtempSync(join(os.tmpdir(), `${prefix}origin-`));
  tempDirs.push(repoPath);
  tempDirs.push(originPath);
  git(repoPath, ['init', '-q', '-b', 'main']);
  git(repoPath, ['config', 'user.email', 'test@o8.dev']);
  git(repoPath, ['config', 'user.name', 'o8 test']);
  writeFileSync(join(repoPath, 'base.txt'), 'base\n');
  git(repoPath, ['add', 'base.txt']);
  git(repoPath, ['commit', '-q', '-m', 'base']);
  git(originPath, ['init', '-q', '--bare']);
  git(repoPath, ['remote', 'add', 'origin', originPath]);
  git(repoPath, ['push', '-u', 'origin', 'main']);
  return repoPath;
}

function commitMergeFile(cwd: string, file: string, body: string, message: string): string {
  writeFileSync(join(cwd, file), body);
  git(cwd, ['add', file]);
  git(cwd, ['commit', '-q', '-m', message]);
  return gitOut(cwd, ['rev-parse', 'HEAD']);
}

async function makeMergeWorktree(repoPath: string, packetId: string, branch: string): Promise<string> {
  const previous = process.env.O8_SKIP_PRELAUNCH_TYPECHECK;
  process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';
  const launch = await prepareLaunchWorktree({
    repoRoot: repoPath,
    agentType: 'codex',
    taskName: `merge truth ${packetId}`,
    branchName: branch,
    baseBranch: 'main',
    isolate: true,
    skipSetup: true,
    packetId,
  }).finally(() => {
    if (previous === undefined) delete process.env.O8_SKIP_PRELAUNCH_TYPECHECK;
    else process.env.O8_SKIP_PRELAUNCH_TYPECHECK = previous;
  });
  expect(launch).toBeTruthy();
  tempDirs.push(launch!.cwd);
  return launch!.cwd;
}

function mergePacketFixture(packetId: string, repoPath: string, overrides: Partial<OrchestratorPacket> = {}): OrchestratorPacket {
  return packetFixture({
    id: packetId,
    referenceLabel: 'PKT-MERGE',
    title: 'merge truth seam',
    summary: 'Exercise merge truth through the real service.',
    status: 'awaiting_review',
    queueState: 'held',
    releaseState: 'pending',
    workspaceTargetPath: repoPath,
    branchTarget: 'main',
    ...overrides,
  });
}

describe('seam F — merge preview blocks dirty review worktrees', () => {
  it('real merge-preview route returns clean-worktree blocker for uncommitted writes after review', async () => {
    const packetId = 'pkt-seam-F-dirty-preview';
    const repoPath = makeDirtyGitRepo();
    const lane = createLane({
      repoPath,
      worktreePath: repoPath,
      branch: 'inline/seam-f',
      baseBranch: 'main',
      runtime: 'codex',
      packetId,
      sessionKey: 'codex-owned:seam-F-dirty',
    });
    setLaneStatus(lane.id, 'reviewing', 'system', 'review_ready');

    const res = await mergePreviewRoute.GET(operatorGet(`http://localhost:3001/api/orchestrator/merge-preview?packetId=${packetId}`));
    expect(res.status).toBe(200);
    const preview = await res.json();

    expect(preview.wouldMerge).toBe(false);
    expect(preview.blockers).toContain('clean-worktree');
    expect(preview.checks.some((check: { name: string; verdict: string }) =>
      check.name === 'clean-worktree' && check.verdict === 'fail'
    )).toBe(true);
  });
});

// ── Seam G — merge truth: release flags and review pins are git-verified ────

describe('seam G — merge truth verifies release claims and carries same-patch reviews', () => {
  it('reconstruction leaves live unmerged lanes pending and approve_and_merge does not short-circuit', async () => {
    const repoPath = makeMergeRepo('o8-seam-G-reconstruct-');
    const packetId = 'pkt-seam-G-reconstruct';
    const missionId = `mission-seam-G-historical-${Date.now()}`;
    createLane({ repoPath, worktreePath: repoPath, branch: 'inline/seam-g-reconstruct', runtime: 'codex', packetId });
    recordMission({
      id: missionId,
      repoPath,
      runtime: 'codex',
      prompt: 'historical reconstruction',
      summary: 'historical reconstruction',
      constraints: '',
      packetMeta: [{ id: packetId, title: 'historical packet', referenceLabel: 'PKT-HIST' }],
      totalWaves: 1,
    });
    getSqlite().prepare('UPDATE missions SET mission_state_json = NULL WHERE id = ?').run(missionId);
    writeOrchestratorControlPlaneState(createEmptyOrchestratorMissionState());

    const status = await getMissionStatus({ missionId, includeCost: false });
    const packet = status.packets.find((candidate) => candidate.id === packetId);
    expect(packet).toBeTruthy();
    expect(packet?.releaseState).toBe('pending');
    await expect(approveAndMergePacket({ packetId })).resolves.not.toMatchObject({
      alreadyReleased: true,
    });
  });

  it('stale released flag with no main ancestry self-repairs and merge proceeds', async () => {
    // Merge here crosses the storage governor, which is not what this seam proves.
    await updateOperatorDefaults({
      storageReserveRatio: 0.0001,
      storageReserveFloorGb: 0.001,
    });
    const repoPath = makeMergeRepo('o8-seam-G-stale-');
    const packetId = 'pkt-seam-G-stale';
    const branch = 'inline/seam-g-stale';
    const worktreePath = await makeMergeWorktree(repoPath, packetId, branch);
    const lane = createLane({ repoPath, worktreePath, branch, baseBranch: 'main', runtime: 'codex', packetId });
    setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');
    const reviewedHead = commitMergeFile(worktreePath, 'feature.txt', 'feature\n', 'feat: stale release seam [via-o8]');
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      repoPath,
      packets: [mergePacketFixture(packetId, repoPath, {
        releaseState: 'released',
        releaseStatePayload: { mergeCommit: '0123456789012345678901234567890123456789' },
      })],
    });
    await submitPacketReview({ packetId, approved: true, findings: [], reviewedHeadSha: reviewedHead });

    const result = await approveAndMergePacket({ packetId });
    expect(result.merged).toBe(true);
    expect(result.alreadyReleased).toBeUndefined();
    expect(result.mergeSha).toBe(gitOut(repoPath, ['rev-parse', 'HEAD']));
  }, 20_000);

  it('patch-id carry allows unchanged rebased review and still rejects changed content', async () => {
    // Merge here crosses the storage governor, which is not what this seam proves.
    await updateOperatorDefaults({
      storageReserveRatio: 0.0001,
      storageReserveFloorGb: 0.001,
    });
    const repoPath = makeMergeRepo('o8-seam-G-patch-id-');
    const packetId = 'pkt-seam-G-patch-id';
    const branch = 'inline/seam-g-patch-id';
    const worktreePath = await makeMergeWorktree(repoPath, packetId, branch);
    const lane = createLane({ repoPath, worktreePath, branch, baseBranch: 'main', runtime: 'codex', packetId });
    setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');
    const reviewedHead = commitMergeFile(worktreePath, 'feature.txt', 'feature\n', 'feat: patch id seam [via-o8]');
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      repoPath,
      packets: [mergePacketFixture(packetId, repoPath)],
    });
    await submitPacketReview({ packetId, approved: true, findings: [], reviewedHeadSha: reviewedHead });

    commitMergeFile(repoPath, 'base.txt', 'base\nadvanced\n', 'chore: advance base');
    git(worktreePath, ['rebase', 'main']);
    const rebasedHead = gitOut(worktreePath, ['rev-parse', 'HEAD']);
    expect(rebasedHead).not.toBe(reviewedHead);

    const merged = await approveAndMergePacket({ packetId });
    expect(merged.merged).toBe(true);
    expect(getLaneEvents(lane.id).some((event) =>
      event.verb === 'review_carried_across_rebase'
      && event.payload.from === reviewedHead
      && event.payload.to === rebasedHead
    )).toBe(true);

    const changedPacketId = 'pkt-seam-G-patch-id-changed';
    const changedBranch = 'inline/seam-g-patch-id-changed';
    const changedWorktree = await makeMergeWorktree(repoPath, changedPacketId, changedBranch);
    const changedLane = createLane({ repoPath, worktreePath: changedWorktree, branch: changedBranch, baseBranch: 'main', runtime: 'codex', packetId: changedPacketId });
    setLaneStatus(changedLane.id, 'reviewing', 'system', 'review_requested');
    const changedReviewed = commitMergeFile(changedWorktree, 'changed.txt', 'reviewed\n', 'feat: reviewed changed seam [via-o8]');
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      repoPath,
      packets: [mergePacketFixture(changedPacketId, repoPath)],
    });
    await submitPacketReview({ packetId: changedPacketId, approved: true, findings: [], reviewedHeadSha: changedReviewed });
    const changedHead = commitMergeFile(changedWorktree, 'changed.txt', 'reviewed\nnew content\n', 'feat: post review changed seam [via-o8]');

    const refused = await approveAndMergePacket({ packetId: changedPacketId });
    expect(refused).toMatchObject({
      merged: false,
      reason: 'head_moved_since_review',
      reviewedHeadSha: changedReviewed,
      currentHeadSha: changedHead,
    });
  }, 30_000);
});

// ── Seam H — no-commit completion remains operator-visible (#1578) ─────────

describe('seam H — reconciled no-commit completion persists an outcome and inbox note', () => {
  it('a persisted reviewing lane with a missing branch finishes as no_changes and creates a supervisor inbox row', async () => {
    const repoPath = makeMergeRepo('o8-seam-H-no-changes-');
    const packetId = 'pkt-seam-H-no-changes';
    const packetTitle = 'Fix silent packet completion';
    const lane = createLane({
      repoPath,
      worktreePath: repoPath,
      branch: 'agent/never-created',
      baseBranch: 'main',
      runtime: 'codex',
      packetId,
      label: packetTitle,
    });
    // The real path into `reviewing` is post-completion-packet.ts, which emits
    // 'agent_completed'; that label is what the durable-launch evidence guard reads.
    setLaneStatus(lane.id, 'reviewing', 'system', 'agent_completed');
    writeOrchestratorControlPlaneState(createEmptyOrchestratorMissionState());

    await expect(sweepPacketsMergedByAncestry()).resolves.toMatchObject({ merged: 1 });

    expect(getLane(lane.id)).toMatchObject({
      id: lane.id,
      status: 'archived',
      outcome: 'no_changes',
      outcomeNote: 'Agent finished without making changes',
    });

    const inboxRow = getSqlite().prepare(`
      SELECT repo_path, packet_id, kind, payload, status
      FROM supervisor_inbox
      WHERE packet_id = ? AND kind = 'packet_no_changes'
      ORDER BY datetime(created_at) DESC
      LIMIT 1
    `).get(packetId) as {
      repo_path: string;
      packet_id: string;
      kind: string;
      payload: string;
      status: string;
    } | undefined;
    expect(inboxRow).toMatchObject({
      repo_path: repoPath,
      packet_id: packetId,
      kind: 'packet_no_changes',
      status: 'pending',
    });
    expect(JSON.parse(inboxRow?.payload ?? '{}')).toMatchObject({
      packetTitle,
      outcome: 'no_changes',
      note: expect.stringContaining('produced no changes'),
    });
  }, 20_000);
});

// ── Seam I — every archive has a durable ending (#1231) ────────────────────

describe('seam I — archiveLane backfills a missing ending and reports the contract violation', () => {
  it('a persisted lane archived without an outcome becomes no_changes and creates a supervisor inbox row', () => {
    const repoPath = `/tmp/o8-seam-I-${Date.now()}`;
    const packetId = `pkt-seam-I-${Date.now()}`;
    const lane = createLane({
      repoPath,
      branch: 'agent/missing-ending',
      runtime: 'codex',
      packetId,
      label: 'Archive contract seam',
    });

    expect(archiveLane(lane.id, 'system')).toMatchObject({
      id: lane.id,
      status: 'archived',
      outcome: 'no_changes',
      outcomeNote: 'Archived without a recorded ending',
    });

    const item = listInboxItems({ includeAllProjects: true })
      .find((candidate) => candidate.packetId === packetId && candidate.kind === 'packet_no_changes');
    expect(item).toMatchObject({
      repoPath,
      packetId,
      status: 'human_required',
      payload: {
        laneId: lane.id,
        laneLabel: 'Archive contract seam',
        repoPath,
        outcome: 'no_changes',
        note: 'Archived without a recorded ending',
      },
    });
  });
});

// ── Seam J — successful PR creation is a terminal outcome (#1231) ─────────

describe('seam J — create_pr success persists the pull-request ending', () => {
  it('the real lane command push/PR path stamps pr_opened with the PR reference', async () => {
    // Dispatch here crosses the storage governor, which is not what this seam proves.
    // Pinning the reserve keeps the assertion independent of the host's free disk.
    await updateOperatorDefaults({
      storageReserveRatio: 0.0001,
      storageReserveFloorGb: 0.001,
    });
    const repoPath = makeMergeRepo('o8-seam-J-pr-');
    const packetId = `pkt-seam-J-${Date.now()}`;
    const branch = 'agent/seam-j-pr';
    const worktreePath = await makeMergeWorktree(repoPath, packetId, branch);
    commitMergeFile(worktreePath, 'pull-request.txt', 'ready for review\n', 'feat: PR outcome seam');
    const lane = createLane({
      repoPath,
      worktreePath,
      branch,
      baseBranch: 'main',
      runtime: 'codex',
      packetId,
      label: 'PR outcome seam',
    });

    const fakeBin = mkdtempSync(join(os.tmpdir(), 'o8-seam-J-bin-'));
    tempDirs.push(fakeBin);
    const fakeGh = join(fakeBin, 'gh');
    writeFileSync(fakeGh, '#!/bin/sh\nprintf "%s\\n" "https://github.com/hurttlocker/o8/pull/1231"\n');
    chmodSync(fakeGh, 0o755);
    const previousPath = process.env.PATH ?? '';
    process.env.PATH = `${fakeBin}:${previousPath}`;

    try {
      await expect(dispatch({ verb: 'create_pr', laneId: lane.id, actor: 'user' })).resolves.toMatchObject({
        ok: true,
        note: 'PR created: https://github.com/hurttlocker/o8/pull/1231',
      });
    } finally {
      process.env.PATH = previousPath;
    }

    expect(getLane(lane.id)).toMatchObject({
      status: 'reviewing',
      prNumber: 1231,
      outcome: 'pr_opened',
      outcomeNote: 'Pull request opened: https://github.com/hurttlocker/o8/pull/1231',
    });
  }, 20_000);
});

// ── Seam K — awaiting_human always carries a question (#1231) ──────────────

describe('seam K — awaiting_human escalation persists a specific supervisor question', () => {
  it('the real wedge sweep creates the question row and archives the unanswered lane as asked', () => {
    const now = Date.now();
    const repoPath = `/tmp/o8-seam-K-${now}`;
    const packetId = `pkt-seam-K-${now}`;
    const lane = createLane({
      repoPath,
      branch: 'agent/awaiting-question',
      runtime: 'codex',
      packetId,
      label: 'Question contract seam',
    });
    setLaneStatus(lane.id, 'awaiting_orchestrator', 'system', 'worker_question');
    updateLane(lane.id, {
      lastEventAt: new Date(now - WEDGE_AWAITING_ORCHESTRATOR_MS - 1).toISOString(),
    });

    expect(listInboxItems({ includeAllProjects: true }).some((item) => item.packetId === packetId)).toBe(false);
    expect(enforceWedgeTimeouts(now)).toHaveLength(1);

    expect(getLane(lane.id)).toMatchObject({ status: 'awaiting_human', outcome: null });
    const item = listInboxItems({ includeAllProjects: true })
      .find((candidate) => candidate.packetId === packetId && candidate.kind === 'bounded_retry_exhausted');
    expect(item?.payload).toMatchObject({
      laneId: lane.id,
      laneLabel: 'Question contract seam',
      blockedReason: 'orchestrator_wedge_timeout',
      question: expect.stringContaining('Question contract seam'),
    });
    expect(item?.payload.question).toContain('retry, steer, or archive it?');

    expect(archiveLane(lane.id, 'system')).toMatchObject({
      status: 'archived',
      outcome: 'asked',
      outcomeNote: item?.payload.question,
    });
  });
});

// ── Seam L — bounded retries preserve packet identity (#1521) ───────────────

describe('seam L — ralph retry and post-completion lookup preserve the persisted packet binding', () => {
  it('ralph requeue against a persisted lane emits the real packetId, never an empty string', () => {
    const now = Date.now();
    const packetId = `pkt-seam-L-requeue-${now}`;
    const lane = createLane({
      repoPath: `/tmp/o8-seam-L-requeue-${now}`,
      branch: 'agent/ralph-requeue',
      runtime: 'codex',
      packetId,
      label: 'Ralph retry identity seam',
    });

    const result = markRalphRetryRequeued(lane.id, '');

    expect(result).toMatchObject({ packetId, lane: { id: lane.id, packetId } });
    const event = getLaneEvents(lane.id).find((candidate) =>
      candidate.verb === 'update'
      && candidate.payload.lastEventLabel === 'ralph_retry_requeued'
    );
    expect(event?.payload.packetId).toBe(packetId);
    expect(event?.payload.packetId).not.toBe('');
  });

  it('empty post-completion payload resolves through the persisted lane and transitions to reviewing', async () => {
    const now = Date.now();
    const repoPath = `/tmp/o8-seam-L-completion-${now}`;
    const packetId = `pkt-seam-L-completion-${now}`;
    const lane = createLane({
      repoPath,
      branch: 'agent/post-completion-fallback',
      runtime: 'codex',
      packetId,
      label: 'Post-completion packet fallback seam',
    });
    setLaneStatus(lane.id, 'running', 'system', 'session_running');
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      repoPath,
      packets: [packetFixture({
        id: packetId,
        status: 'running',
        queueState: 'queued',
        maxAttempts: 3,
      })],
    });

    await expect(resolvePostCompletionPacket(lane.id, '')).resolves.toMatchObject({
      packetId,
      snapshot: { attemptCount: 0, maxAttempts: 3 },
    });
    const transition = transitionPostCompletionLaneToReviewing(lane.id, '');

    expect(transition.packetId).toBe(packetId);
    expect(getLane(lane.id)).toMatchObject({
      status: 'reviewing',
      packetId,
      lastEventLabel: 'agent_completed',
    });
    expect(getLaneEvents(lane.id).some((event) =>
      event.payload.lastEventLabel === 'post_completion_typecheck_packet_not_found'
    )).toBe(false);
  });
});

// ── Seam M — Cmd+K reaches persisted Stage 1 search stores (#984) ───────────

async function searchPersistedRows(query: string) {
  const response = await searchRoute.GET(new Request(
    `http://localhost/api/panel/search?q=${encodeURIComponent(query)}`,
  ));
  expect(response.status).toBe(200);
  return response.json() as Promise<{
    groups: Record<string, Array<{
      id: string;
      title: string;
      detail: string;
      target?: Record<string, unknown>;
    }>>;
  }>;
}

describe('seam M — the real Cmd+K route searches persisted Stage 1 rows', () => {
  it('finds a phrase from the middle of a persisted chat and keeps its thread id', async () => {
    const tabId = `thoughts-search-seam-${Date.now()}`;
    const phrase = `midconversationquartz${Date.now()}`;
    const persistResponse = await chatHistoryRoute.POST(new NextRequest(
      'http://localhost/api/v2/chat-history',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tabId,
          title: 'Search seam conversation',
          messages: [
            { id: 'm1', role: 'user', content: 'Opening message', timestamp: Date.now() - 2 },
            { id: 'm2', role: 'assistant', content: `The hidden ${phrase} appears in the middle.`, timestamp: Date.now() - 1 },
            { id: 'm3', role: 'user', content: 'Closing message', timestamp: Date.now() },
          ],
        }),
      },
    ));
    expect(persistResponse.status).toBe(200);

    const payload = await searchPersistedRows(phrase);
    expect(payload.groups.chat).toEqual(expect.arrayContaining([
      expect.objectContaining({
        detail: expect.stringContaining(`\u0001${phrase}\u0002`),
        target: expect.objectContaining({ chatTabId: tabId }),
      }),
    ]));
  });

  it('does not index serialized message keys and safely rejects hostile FTS syntax', async () => {
    const tabId = `thoughts-search-clean-text-${Date.now()}`;
    await chatHistoryRoute.POST(new NextRequest('http://localhost/api/v2/chat-history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tabId,
        title: 'Clean text index seam',
        messages: [{
          id: 'clean-message',
          role: 'assistant',
          content: 'Only human-readable prose belongs in this index.',
          timestamp: Date.now(),
        }],
      }),
    }));

    const metadataPayload = await searchPersistedRows('timestamp');
    expect(metadataPayload.groups.chat.map((result) => result.id)).not.toContain(`chat:${tabId}`);

    const hostilePayload = await searchPersistedRows('"unbalanced or co-op* NEAR(');
    expect(hostilePayload.groups.chat).toEqual([]);
    expect(hostilePayload.groups.transcript).toEqual([]);
  });

  it('removes the parent and FTS rows when a canonical thread is deleted', async () => {
    const tabId = `thoughts-search-delete-${Date.now()}`;
    const phrase = `deleteindexviolet${Date.now()}`;
    await chatHistoryRoute.POST(new NextRequest('http://localhost/api/v2/chat-history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tabId,
        messages: [{ id: 'delete-message', role: 'user', content: phrase, timestamp: Date.now() }],
      }),
    }));
    const response = await chatHistoryRoute.DELETE(new NextRequest(
      `http://localhost/api/v2/chat-history?tabId=${encodeURIComponent(tabId)}`,
      { method: 'DELETE' },
    ));
    expect(response.status).toBe(200);
    expect(getSqlite().prepare('SELECT 1 FROM chat_history WHERE tab_id = ?').get(tabId)).toBeUndefined();
    expect(getSqlite().prepare('SELECT 1 FROM chat_history_fts WHERE tab_id = ?').get(tabId)).toBeUndefined();
  });

  it('resumes bounded legacy chat backfill and indexes the final file', async () => {
    const historyDir = join(dataDir, 'chat-history');
    mkdirSync(historyDir, { recursive: true });
    const stamp = Date.now();
    const phrase = `backfillindigo${stamp}`;
    for (let index = 0; index < 13; index += 1) {
      writeFileSync(join(historyDir, `000-backfill-${stamp}-${String(index).padStart(2, '0')}.json`), JSON.stringify({
        title: `Backfill ${index}`,
        messages: [{
          id: `backfill-message-${index}`,
          role: 'user',
          content: index === 12 ? phrase : `Backfill body ${index}`,
          timestamp: stamp + index,
        }],
      }));
    }
    getSqlite().prepare("DELETE FROM search_backfill_state WHERE name = 'v35-chat-history'").run();

    await runChatHistorySearchBackfill({ maxBatches: 1 });
    const paused = getSqlite().prepare(`
      SELECT cursor, completed_at FROM search_backfill_state WHERE name = 'v35-chat-history'
    `).get() as { cursor: string; completed_at: string | null };
    expect(paused.cursor).not.toBe('');
    expect(paused.completed_at).toBeNull();

    await runChatHistorySearchBackfill();
    const completed = getSqlite().prepare(`
      SELECT completed_at FROM search_backfill_state WHERE name = 'v35-chat-history'
    `).get() as { completed_at: string | null };
    expect(completed.completed_at).not.toBeNull();
    const payload = await searchPersistedRows(phrase);
    expect(payload.groups.chat.some((result) => result.id.includes(`000-backfill-${stamp}-12`))).toBe(true);
  });

  it('finds indexed transcript text and a session-outcome summary by packet id', async () => {
    const now = Date.now();
    const transcriptPacketId = `pkt-search-transcript-${now}`;
    const transcriptPhrase = `runtimeamber${now}`;
    syncTranscriptSearchDocument({
      packetId: transcriptPacketId,
      laneId: `lane-search-transcript-${now}`,
      sessionKey: `codex-search-transcript-${now}`,
      title: 'Transcript search seam',
      repoPath: '/tmp/o8-search-seam',
      runtime: 'codex',
      entries: [{
        id: 'entry-1',
        role: 'assistant',
        text: `Completed the ${transcriptPhrase} implementation path.`,
        timestamp: new Date(),
      }],
      completedAt: new Date().toISOString(),
    });

    const outcomePacketId = `pkt-search-outcome-${now}`;
    const outcomePhrase = `outcomesaffron${now}`;
    getSqlite().prepare(`
      INSERT INTO session_outcomes (
        id, repo_path, runtime, packet_id, outcome, summary,
        retry_history_json, patterns_json, conflict_zones_json,
        changed_files_json, started_at, completed_at, valid_from
      ) VALUES (?, ?, ?, ?, ?, ?, '[]', '[]', '[]', '[]', ?, ?, ?)
    `).run(
      `outcome-search-seam-${now}`,
      '/tmp/o8-search-seam',
      'codex',
      outcomePacketId,
      'succeeded',
      `Persisted ${outcomePhrase} in the session ledger.`,
      new Date(now - 1000).toISOString(),
      new Date(now).toISOString(),
      new Date(now).toISOString(),
    );

    const transcriptPayload = await searchPersistedRows(transcriptPhrase);
    expect(transcriptPayload.groups.transcript).toEqual(expect.arrayContaining([
      expect.objectContaining({
        detail: expect.stringContaining(transcriptPhrase),
        target: expect.objectContaining({ packetId: transcriptPacketId }),
      }),
    ]));

    const outcomePayload = await searchPersistedRows(outcomePhrase);
    expect(outcomePayload.groups.transcript).toEqual(expect.arrayContaining([
      expect.objectContaining({
        detail: expect.stringContaining(outcomePhrase),
        target: expect.objectContaining({ packetId: outcomePacketId }),
      }),
    ]));
  });

  it('backfills a pre-upgrade completed packet through its runtime transcript reader', async () => {
    const now = Date.now();
    const packetId = `pkt-search-preupgrade-${now}`;
    const phrase = `preupgradeumber${now}`;
    getSqlite().prepare(`
      INSERT INTO session_outcomes (
        id, repo_path, runtime, session_key, packet_id, outcome, summary,
        retry_history_json, patterns_json, conflict_zones_json,
        changed_files_json, started_at, completed_at, valid_from
      ) VALUES (?, ?, 'codex', ?, ?, 'succeeded', 'Legacy packet summary',
        '[]', '[]', '[]', '[]', ?, ?, ?)
    `).run(
      `outcome-preupgrade-${now}`,
      '/tmp/o8-search-seam',
      `codex-preupgrade-${now}`,
      packetId,
      new Date(now - 1_000).toISOString(),
      new Date(now).toISOString(),
      new Date(now).toISOString(),
    );
    getSqlite().prepare("DELETE FROM search_backfill_state WHERE name = 'v35-packet-transcripts'").run();

    await runPacketTranscriptSearchBackfill({
      resolveRuntime: () => ({
        capabilities: { readTranscript: true },
        readTranscript: async () => [{
          id: 'preupgrade-entry',
          role: 'assistant',
          text: `Recovered ${phrase} from the runtime transcript.`,
          timestamp: new Date(now),
        }],
      }) as never,
    });

    const payload = await searchPersistedRows(phrase);
    expect(payload.groups.transcript).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: expect.objectContaining({ packetId }) }),
    ]));
  });

  it('finds a persisted approval and routes it to Inbox', async () => {
    const now = Date.now();
    const approvalId = `approval-search-seam-${now}`;
    const phrase = `approvalcobalt${now}`;
    getSqlite().prepare(`
      INSERT INTO approvals (
        id, source, runtime, agent, session_key, title, description, summary,
        risk, status, created_at, updated_at, audit_json, fingerprint
      ) VALUES (?, 'test', 'codex', 'search-seam', ?, ?, ?, ?, 'medium',
        'pending', ?, ?, '[]', ?)
    `).run(
      approvalId,
      `codex-search-approval-${now}`,
      'Approval search seam',
      `Requires ${phrase} confirmation.`,
      `Pending ${phrase} review.`,
      now,
      now,
      `fingerprint-${approvalId}`,
    );

    const payload = await searchPersistedRows(phrase);
    expect(payload.groups.approval).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: `approval:${approvalId}`,
        target: expect.objectContaining({ approvalId, openInbox: true }),
      }),
    ]));
  });
});

// ── Seam N — settled sparse Cmd+K queries reach Brain Recall (#984) ─────────

function recallDirectiveRow(id: string, title: string): TypedRow {
  return {
    citation: {
      kind: 'directive',
      rowId: id,
      table: 'directives_fts',
      excerpt: 'Semantically related directive body.',
    },
    fields: { id, title, body: 'Semantically related directive body.' },
    score: 1,
  };
}

async function searchRecallRoute(query: string, keywordHits: number) {
  const response = await searchRoute.GET(new Request(
    `http://localhost/api/panel/search?mode=recall&q=${encodeURIComponent(query)}&workspace=${encodeURIComponent(dataDir)}&keywordHits=${keywordHits}`,
  ));
  expect(response.status).toBe(200);
  return response.json() as Promise<{
    groups: Record<string, Array<{
      id: string;
      title: string;
      target?: Record<string, unknown>;
    }>>;
  }>;
}

describe('seam N — the real Cmd+K route gates and serves semantic Recall', () => {
  it('runs once for sparse settled results and skips rich keyword results', async () => {
    const classify = vi.fn(async () => ({ class: 'A' as const, bm25Variants: ['adjacent wording'] }));
    const stamp = Date.now();
    const outcomeId = `recall-outcome-${stamp}`;
    const packetId = `pkt-recall-${stamp}`;
    const laneId = `lane-recall-${stamp}`;
    const sessionKey = `codex-recall-${stamp}`;
    getSqlite().prepare(`
      INSERT INTO session_outcomes (
        id, repo_path, runtime, session_key, packet_id, lane_id, outcome, summary,
        retry_history_json, patterns_json, conflict_zones_json,
        changed_files_json, started_at, completed_at, valid_from
      ) VALUES (?, ?, 'codex', ?, ?, ?, 'succeeded', ?,
        '[]', '[]', '[]', '[]', ?, ?, ?)
    `).run(
      outcomeId,
      dataDir,
      sessionKey,
      packetId,
      laneId,
      'Recall outcome summary head',
      new Date(stamp - 1_000).toISOString(),
      new Date(stamp).toISOString(),
      new Date(stamp).toISOString(),
    );
    const rows: TypedRow[] = [
      recallDirectiveRow('recall-sparse-directive', 'Sparse semantic directive'),
      {
        citation: { kind: 'outcome', rowId: outcomeId, table: 'session_outcomes', excerpt: 'Outcome excerpt' },
        fields: { summary: 'Recall outcome summary head', repoPath: dataDir },
        score: 0.9,
      },
      {
        citation: { kind: 'doc', rowId: `doc-${stamp}`, table: 'docs', sourcePath: 'docs/recall.md' },
        fields: { title: 'Recall architecture document', repoName: basename(dataDir), relPath: 'docs/recall.md' },
        score: 0.8,
      },
    ];
    setRecallDependenciesForTests({
      assertSpend: async () => {},
      classify,
      embed: async () => [1, 0],
      hasEmbedding: () => true,
      retrieve: async () => [{ retriever: 'fts', rows, durationMs: 1 }],
    });

    const sparse = await searchRecallRoute('adjacent wording', 4);
    expect(sparse.groups.recall).toEqual([expect.objectContaining({
      title: 'Sparse semantic directive',
      target: { directiveId: 'recall-sparse-directive' },
    }), expect.objectContaining({
      title: 'Recall outcome summary head',
      target: { packetId, laneId, sessionKey },
    }), expect.objectContaining({
      title: 'Recall architecture document',
      target: { filePath: join(dataDir, 'docs/recall.md') },
    })]);
    expect(classify).toHaveBeenCalledTimes(1);

    const repeatedSparse = await searchRecallRoute('adjacent wording', 4);
    expect(repeatedSparse.groups.recall).toHaveLength(3);
    expect(classify).toHaveBeenCalledTimes(1);

    const rich = await searchRecallRoute('another rich query', 5);
    expect(rich.groups.recall).toEqual([]);
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it('serves a semantically adjacent query from a pre-seeded scope-fenced cache row', async () => {
    const projectId = (await getActiveProjectScopeForRepo(dataDir)).projectId;
    const row = recallDirectiveRow('recall-cache-directive', 'Cached Brain citation title');
    seedRecallCacheForTests({
      question: 'durable conversation storage',
      repoPath: dataDir,
      projectId,
      rows: [row],
      vector: [1, 0],
    });
    const classify = vi.fn(async () => { throw new Error('classifier must not run on a semantic hit'); });
    setRecallDependenciesForTests({
      assertSpend: async () => {},
      classify,
      embed: async () => [1, 0],
      hasEmbedding: () => true,
    });

    const payload = await searchRecallRoute('keep chat writes consistent', 0);
    expect(payload.groups.recall).toEqual([expect.objectContaining({
      title: 'Cached Brain citation title',
      target: { directiveId: 'recall-cache-directive' },
    })]);
    expect(classify).not.toHaveBeenCalled();
  });

  it('renders no Recall rows when the Brain daily cap is exhausted', async () => {
    const classify = vi.fn(async () => ({ class: 'A' as const, bm25Variants: ['must not run'] }));
    const embed = vi.fn(async () => [1, 0]);
    setRecallDependenciesForTests({
      assertSpend: async () => { throw new Error('daily cap reached'); },
      classify,
      embed,
      hasEmbedding: () => true,
    });

    const payload = await searchRecallRoute('cap exhausted recall', 0);
    expect(payload.groups.recall).toEqual([]);
    expect(classify).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
  });

  it('renders no Recall rows on a keyless install', async () => {
    const assertSpend = vi.fn(async () => {});
    const classify = vi.fn(async () => ({ class: 'A' as const, bm25Variants: ['must not run'] }));
    setRecallDependenciesForTests({
      assertSpend,
      classify,
      hasEmbedding: () => false,
    });

    const payload = await searchRecallRoute('keyless recall query', 0);
    expect(payload.groups.recall).toEqual([]);
    expect(assertSpend).not.toHaveBeenCalled();
    expect(classify).not.toHaveBeenCalled();
  });
});
