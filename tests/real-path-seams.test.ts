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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';

const runtimeInventoryMock = vi.hoisted(() => ({
  agents: [] as Array<{
    sessionKey: string;
    runtime: 'codex' | 'claude-code';
    status: string;
    currentTask?: string | null;
    lastEventAt?: string | null;
    runtimeSurface?: {
      ownership?: 'provider' | 'discovered' | 'owned';
      capabilities?: { sendInput?: boolean; interrupt?: boolean };
      lifecycle?: { availability?: 'awaiting-thread' | 'running' | 'ready-for-resume' };
    };
  }>,
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
  getRuntimeInventorySnapshot: vi.fn(async () => ({ agents: runtimeInventoryMock.agents })),
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

const { buildPacketPrompt } = await import('@/lib/orchestrator/packet-prompt');
const { addSessionRule } = await import('@/lib/db/session-rules-store');
const mergeRoute = await import('@/app/api/orchestrator/merge/route');
const mergePreviewRoute = await import('@/app/api/orchestrator/merge-preview/route');
const stateRoute = await import('@/app/api/orchestrator/state/route');
const createMissionRoute = await import('@/app/api/orchestrator/create-mission/route');
const { createLane, findLaneByPacket, getLane, getLaneEvents, setLaneStatus } = await import('@/lib/lane/registry');
const { listApprovalsForContext } = await import('@/lib/approvals/store');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { sweepPacketsMergedByAncestry } = await import('@/lib/orchestrator/merged-by-ancestry');
const { getMissionStatus, approveAndMergePacket, submitPacketReview } = await import('@/lib/orchestrator/operator-mission-service');
const { recordMission } = await import('@/lib/db/missions-store');
const { getSqlite } = await import('@/lib/db');
const { prepareLaunchWorktree } = await import('@/lib/worktree/launch');

afterEach(() => {
  runtimeInventoryMock.agents = [];
  authDetectMock.unauthRuntime = null;
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

function workerReq(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: { host: 'localhost:3001', authorization: `Bearer ${WORKER_TOKEN}` },
    body: JSON.stringify(body),
  });
}
function operatorReq(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: { host: 'localhost:3001' },
    body: JSON.stringify(body),
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

    const res = await mergeRoute.POST(workerReq(url, { packetId }));
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

// ── Seam E — omitted mission runtime uses the effective paired default ──────

describe('seam E — create-mission without a runtime uses the paired operator default', () => {
  const url = 'http://localhost:3001/api/orchestrator/create-mission';

  it('orchestratorBackend=codex + no explicit dispatch choice creates Claude Code packets', async () => {
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
        title: 'dispatch paired default seam',
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
    expect(packet.workerRouting.requestedEffort).toBe('high');
    expect(packet.workerRouting.selectedEffort).toBe('high');
  });

  it('subscriptionProfile=claude-only creates Claude Code + Sonnet worker packets', async () => {
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
    expect(packet.huddle).toBe(true);

    const prompt = await buildPacketPrompt(packet, state.mission.packets);
    // This packet is BOTH huddle-armed (create-mission auto-arms cheap tier) and
    // advisor-armed. The two sections overlap, so the assembler emits exactly one
    // alignment block — the explicit huddle section wins, the advisor section is
    // de-duped out.
    expect(prompt).toContain('Huddle mode (this packet)');
    expect(prompt).not.toContain('Advisor discipline (single-sub cheap-tier worker)');
    expect(prompt).toContain('Engineering Brain available');
  });

  it('subscriptionProfile=both preserves today routing exactly', async () => {
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
    expect(packet.workerRouting.selectedRuntime).toBe('claude-code');
    expect(packet.workerRouting.selectedModel).toBeNull();
    expect(packet.huddle).toBeUndefined();
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
    expect(packet.huddle).toBeUndefined();
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
    setLaneStatus(lane.id, 'reviewing', 'system', 'agent_turn_completed');
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
