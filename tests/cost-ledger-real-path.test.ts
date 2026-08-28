import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentRuntime, RuntimeTranscriptEntry } from '@/lib/runtimes/types';

const cacheRoot = join(process.cwd(), 'node_modules', '.cache');
mkdirSync(cacheRoot, { recursive: true });
const dataDir = mkdtempSync(join(cacheRoot, 'o8-cost-ledger-real-path-'));
const repoPath = join(dataDir, 'repo');
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;

vi.mock('@/lib/panel/auth', () => ({ requirePanelAuth: () => null }));
vi.mock('@/lib/runtime/inventory', () => ({ getRuntimeInventorySnapshot: async () => ({ agents: [] }) }));
vi.mock('@/lib/search/transcripts', () => ({ syncTranscriptSearchDocument: () => undefined }));
vi.mock('@/lib/lane/lane-diff-facts', () => ({
  getLaneDiffFacts: () => ({ changedFiles: 0, addedDiffLines: 0 }),
  getLaneSpokenDiffFacts: () => undefined,
}));

function git(...args: string[]) {
  return execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' }).toString().trim();
}

function transcript(): RuntimeTranscriptEntry[] {
  return [{
    id: 'cost-ledger-completion',
    role: 'assistant',
    text: 'Implemented and verified the cost ledger.',
    timestamp: new Date('2026-08-28T16:00:00.000Z'),
  }];
}

beforeAll(async () => {
  mkdirSync(repoPath, { recursive: true });
  git('init', '--initial-branch=main');
  writeFileSync(join(repoPath, 'README.md'), 'cost ledger real path\n');
  git('add', 'README.md');
  git('-c', 'user.email=test@o8.test', '-c', 'user.name=o8-test', 'commit', '-m', 'init');

  const runtime: AgentRuntime = {
    id: 'codex',
    displayName: 'Cost ledger test runtime',
    capabilities: {
      discover: false,
      readTranscript: true,
      launch: false,
      resume: false,
      interrupt: false,
      reviewDiffs: true,
      costTelemetry: false,
      streaming: false,
    },
    discoverSessions: async () => [],
    readTranscript: async () => transcript(),
    launch: async () => ({ ok: false, note: 'not supported' }),
    resume: async () => ({ ok: false, note: 'not supported' }),
    interrupt: async () => ({ ok: false, note: 'not supported' }),
    getChangedFiles: async () => [],
  };
  const { registerRuntime } = await import('@/lib/runtimes/registry');
  registerRuntime(runtime);
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('cost ledger persisted real path', () => {
  it('keeps retry attempts distinct and carries the same totals through outcomes and status', async () => {
    const { getSqlite } = await import('@/lib/db');
    const columns = getSqlite().prepare('PRAGMA table_info(usage_logs)').all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'lane_id',
      'packet_id',
      'mission_id',
      'role',
      'attempt',
      'run_id',
      'metadata_json',
    ]));

    const { createMission } = await import('@/lib/orchestrator/operator-mission-service');
    const mission = await createMission({
      issues: [{
        number: 1_973_001,
        title: 'inline: verify retry cost attribution',
        body: 'Persist two attempts and verify the outcome and status receipts.',
        url: '',
      }],
      repoPath,
      runtime: 'codex',
      constraints: 'Real-path cost ledger regression.',
      taskContract: 'off',
    });
    const packetId = mission.packets[0]!.id;
    const sessionKey = 'codex-owned:cost-ledger-retry';
    const { appendEvent, createLane, setLaneStatus } = await import('@/lib/lane/registry');
    const lane = createLane({
      repoPath,
      worktreePath: repoPath,
      branch: 'fix/cost-ledger-real-path',
      runtime: 'codex',
      packetId,
      sessionKey,
    });
    setLaneStatus(lane.id, 'running', 'system', 'session_launched');

    const { persistSessionCost } = await import('@/lib/orchestrator/cost-persistence');
    await persistSessionCost({
      sessionKey,
      runtime: 'codex',
      model: 'gpt-test',
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.1,
      repoPath,
      laneId: lane.id,
      packetId,
      role: 'worker',
    });
    appendEvent(lane.id, 'steered_packet', 'orchestrator', {
      packetId,
      source: 'operator',
      message: 'Retry with the persisted correction.',
    });
    await persistSessionCost({
      sessionKey,
      runtime: 'codex',
      model: 'gpt-test',
      inputTokens: 250,
      outputTokens: 70,
      costUsd: 0.3,
      repoPath,
      laneId: lane.id,
      packetId,
      role: 'worker',
    });

    const usageRows = getSqlite().prepare(`
      SELECT attempt, input_tokens, output_tokens, cost_usd, lane_id, packet_id, mission_id, role
      FROM usage_logs WHERE session_key = ? ORDER BY attempt
    `).all(sessionKey);
    expect(usageRows).toEqual([
      expect.objectContaining({ attempt: 1, input_tokens: 100, output_tokens: 20, cost_usd: 0.1 }),
      expect.objectContaining({ attempt: 2, input_tokens: 150, output_tokens: 50, cost_usd: 0.2 }),
    ]);
    expect(usageRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ lane_id: lane.id, packet_id: packetId, mission_id: mission.missionId, role: 'worker' }),
    ]));

    const reviewRoute = await import('@/app/api/orchestrator/review/route');
    const reviewResponse = await reviewRoute.POST(new NextRequest(
      'http://localhost/api/orchestrator/review',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          packetId,
          clientMutationId: 'cost-ledger-real-path-review',
          approved: true,
          findings: [{
            file: 'README.md',
            line: 1,
            severity: 'note',
            description: 'The persisted receipt matches the requested path.',
            status: 'accepted',
          }, {
            file: 'README.md',
            line: 1,
            severity: 'note',
            description: 'The retry totals remain visible on the outcome.',
            status: 'accepted',
          }],
          reviewedHeadSha: git('rev-parse', 'HEAD'),
        }),
      },
    ));
    expect(reviewResponse.status).toBe(200);
    expect(await reviewResponse.json()).toMatchObject({
      ok: true,
      result: { recorded: true, findingsCount: 2 },
    });

    const { capturePacketCompletionContext } = await import('@/lib/orchestrator/context-relay');
    await capturePacketCompletionContext(packetId, sessionKey);
    await vi.waitFor(() => {
      const outcome = getSqlite().prepare(`
        SELECT attempts, total_tokens, cost_usd, review_approved, review_findings_count
        FROM session_outcomes WHERE packet_id = ?
      `).get(packetId);
      expect(outcome).toEqual({
        attempts: 2,
        total_tokens: 320,
        cost_usd: 0.3,
        review_approved: 1,
        review_findings_count: 2,
      });
    });

    const statusRoute = await import('@/app/api/orchestrator/status/route');
    const response = await statusRoute.GET(new NextRequest(
      `http://localhost/api/orchestrator/status?missionId=${mission.missionId}&includeCost=true`,
    ));
    expect(response.status).toBe(200);
    const payload = await response.json() as {
      ok: boolean;
      result: {
        cost: {
          totalCostUsd: number;
          packetCosts: Array<{ packetId: string; inputTokens: number; outputTokens: number; totalCostUsd: number }>;
          costByRole: Record<string, { inputTokens: number; outputTokens: number; totalCostUsd: number; requestCount: number }>;
        };
      };
    };
    expect(payload.ok).toBe(true);
    expect(payload.result.cost.totalCostUsd).toBe(0.3);
    expect(payload.result.cost.packetCosts).toContainEqual(expect.objectContaining({
      packetId,
      inputTokens: 250,
      outputTokens: 70,
      totalCostUsd: 0.3,
    }));
    expect(payload.result.cost.costByRole.worker).toEqual({
      inputTokens: 250,
      outputTokens: 70,
      totalCostUsd: 0.3,
      requestCount: 2,
    });
  });

  it('preserves a rejected review verdict and its finding count on the outcome', async () => {
    const { createMission } = await import('@/lib/orchestrator/operator-mission-service');
    const mission = await createMission({
      issues: [{
        number: 1_973_002,
        title: 'inline: verify rejected review attribution',
        body: 'Persist the rejected review verdict on the session outcome.',
        url: '',
      }],
      repoPath,
      runtime: 'codex',
      constraints: 'Real-path review ledger regression.',
      taskContract: 'off',
    });
    const packetId = mission.packets[0]!.id;
    const sessionKey = 'codex-owned:cost-ledger-rejected-review';
    const { createLane, setLaneStatus } = await import('@/lib/lane/registry');
    const lane = createLane({
      repoPath,
      worktreePath: repoPath,
      branch: 'fix/cost-ledger-rejected-review',
      runtime: 'codex',
      packetId,
      sessionKey,
    });
    setLaneStatus(lane.id, 'running', 'system', 'session_launched');

    const reviewRoute = await import('@/app/api/orchestrator/review/route');
    const reviewResponse = await reviewRoute.POST(new NextRequest(
      'http://localhost/api/orchestrator/review',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          packetId,
          clientMutationId: 'cost-ledger-rejected-review',
          approved: false,
          findings: [{
            file: 'README.md',
            line: 1,
            severity: 'bug',
            description: 'The first finding remains unresolved.',
            status: 'deferred',
          }, {
            file: 'README.md',
            line: 1,
            severity: 'rule_violation',
            description: 'The second finding requires another pass.',
            status: 'deferred',
          }],
          reviewedHeadSha: git('rev-parse', 'HEAD'),
        }),
      },
    ));
    expect(reviewResponse.status).toBe(200);
    expect(await reviewResponse.json()).toMatchObject({
      ok: true,
      result: { recorded: true, findingsCount: 2 },
    });

    const { capturePacketCompletionContext } = await import('@/lib/orchestrator/context-relay');
    const { getSqlite } = await import('@/lib/db');
    await capturePacketCompletionContext(packetId, sessionKey);
    await vi.waitFor(() => {
      const outcome = getSqlite().prepare(`
        SELECT review_approved, review_findings_count
        FROM session_outcomes WHERE packet_id = ?
      `).get(packetId);
      expect(outcome).toEqual({
        review_approved: 0,
        review_findings_count: 2,
      });
    });
  });
});
