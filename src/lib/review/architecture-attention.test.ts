import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ArchitectureDeltaResult } from './architecture-delta-types';

const h = vi.hoisted(() => ({
  askJudgment: vi.fn(),
  enabled: vi.fn(() => true),
}));

vi.mock('@/lib/judgment/client', () => ({
  TYPESAFE_MODEL: 'jev-latest',
  askJudgment: h.askJudgment,
  thresholdAnswer: (answer: { abstain?: boolean } | null | undefined) => (
    answer?.abstain ? null : answer ?? null
  ),
}));
vi.mock('@/lib/judgment/route', () => ({ isJudgmentRefereeEnabled: h.enabled }));

const { rankArchitectureAttention } = await import('./architecture-attention');

const graph: ArchitectureDeltaResult = {
  ok: true,
  status: 'ready',
  reason: null,
  analysisId: 'analysis-1',
  nodes: [
    { path: 'src/auth/session.ts', state: 'changed', focusPath: 'src/auth/session.ts' },
    { path: 'src/api/route.ts', state: 'changed', focusPath: 'src/api/route.ts' },
    { path: 'src/ui/card.tsx', state: 'changed', focusPath: 'src/ui/card.tsx' },
    { path: 'src/db/store.ts', state: 'context', focusPath: null },
  ],
  edges: [
    { from: 'src/api/route.ts', to: 'src/auth/session.ts', state: 'added', focusPath: 'src/api/route.ts' },
    { from: 'src/auth/session.ts', to: 'src/db/store.ts', state: 'removed', focusPath: 'src/auth/session.ts' },
  ],
  summary: { changedModules: 3, addedEdges: 1, removedEdges: 1, contextEdges: 0 },
  unsupportedPaths: [],
  omittedPaths: [],
  resolutionWarnings: [],
  truncated: false,
  generatedAt: '2026-09-21T00:00:00.000Z',
};

describe('architecture attention', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.enabled.mockReturnValue(true);
    h.askJudgment.mockImplementation(async (request: {
      state: { modules: Array<{ questionIndex: number; path: string }> };
      questions: Record<string, { type: string; criteria?: Record<string, string> }>;
    }) => {
      const answers = Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
        const index = Number(id.split('_').at(-1));
        const path = request.state.modules.find((item) => item.questionIndex === index)?.path ?? '';
        if (question.type === 'score') {
          const score = path.includes('/auth/') ? 2 : path.includes('/api/') ? 1.6 : 0.4;
          return [id, { score, legend: {}, probabilities: { 0: 0.1, 1: 0.2, 2: 0.7 }, confidence: 0.82, abstain: false }];
        }
        const choice = path.includes('/auth/') ? 'auth_trust' : path.includes('/api/') ? 'interface_contract' : 'ui_behavior';
        return [id, { choice, probabilities: { [choice]: 0.8 }, confidence: 0.8, abstain: false }];
      }));
      return {
        answers,
        model: 'jev-latest',
        usage: { inputTokens: 30, outputTokens: 12 },
        latencyMs: 241,
        attempts: 1,
        receiptId: 'receipt-1',
      };
    });
  });

  it('makes one bounded typed call from topology facts and ranks without hiding modules', async () => {
    const result = await rankArchitectureAttention(graph, { laneId: 'lane-1', repoPath: '/worktree-1' });

    expect(h.askJudgment).toHaveBeenCalledTimes(1);
    const request = h.askJudgment.mock.calls[0][0];
    expect(request.state.modules).toHaveLength(3);
    expect(JSON.stringify(request.state)).not.toContain('source');
    expect(Object.keys(request.questions)).toHaveLength(6);
    expect(request.questions.attention_0.instructions).toContain('state.modules[0]');
    expect(request.questions.lens_1.instructions).toContain('state.modules[1]');
    expect(result).toMatchObject({
      status: 'ready',
      model: 'jev-latest',
      latencyMs: 241,
      receiptId: 'receipt-1',
    });
    expect(result.items.slice(0, 2)).toMatchObject([
      { path: 'src/auth/session.ts', rank: 1, lens: 'auth_trust' },
      { path: 'src/api/route.ts', rank: 2, lens: 'interface_contract' },
    ]);
    expect(result.items.map((item) => item.path)).toEqual(expect.arrayContaining([
      'src/auth/session.ts',
      'src/api/route.ts',
      'src/ui/card.tsx',
    ]));
  });

  it('fails open when advisory judgment is off or graph evidence is incomplete', async () => {
    h.enabled.mockReturnValue(false);
    await expect(rankArchitectureAttention(graph, { repoPath: '/worktree-1' })).resolves.toMatchObject({ status: 'disabled', items: [] });

    h.enabled.mockReturnValue(true);
    await expect(rankArchitectureAttention({ ...graph, truncated: true }, { repoPath: '/worktree-1' })).resolves.toMatchObject({
      status: 'incomplete',
      items: [],
    });
    expect(h.askJudgment).not.toHaveBeenCalled();
  });

  it('treats low-confidence answers as abstentions and keeps deterministic fallback order', async () => {
    h.askJudgment.mockResolvedValue({
      answers: Object.fromEntries(Array.from({ length: 6 }, (_, index) => [
        `${index % 2 === 0 ? 'attention' : 'lens'}_${Math.floor(index / 2)}`,
        index % 2 === 0
          ? { score: 2, confidence: 0.2, abstain: true }
          : { choice: 'auth_trust', confidence: 0.2, abstain: true },
      ])),
      model: 'jev-latest',
      usage: { inputTokens: 10, outputTokens: 5 },
      latencyMs: 100,
      attempts: 1,
      receiptId: 'receipt-low',
    });

    const result = await rankArchitectureAttention({ ...graph, analysisId: 'analysis-low-confidence' }, { repoPath: '/worktree-1' });

    expect(result.items[0]).toMatchObject({ path: 'src/auth/session.ts', lens: 'general', attentionScore: null });
    expect(result.items).toHaveLength(3);
  });

  it('places a confident low score before an abstention instead of treating uncertainty as a neutral score', async () => {
    h.askJudgment.mockResolvedValue({
      answers: {
        attention_0: { score: 2, confidence: 0.2, abstain: true },
        lens_0: { choice: 'auth_trust', confidence: 0.2, abstain: true },
        attention_1: { score: 0.2, confidence: 0.8, abstain: false },
        lens_1: { choice: 'interface_contract', confidence: 0.8, abstain: false },
        attention_2: { score: 2, confidence: 0.2, abstain: true },
        lens_2: { choice: 'ui_behavior', confidence: 0.2, abstain: true },
      },
      model: 'jev-latest',
      usage: { inputTokens: 10, outputTokens: 5 },
      latencyMs: 100,
      attempts: 1,
      receiptId: 'receipt-mixed',
    });

    const result = await rankArchitectureAttention({ ...graph, analysisId: 'analysis-mixed-confidence' }, { repoPath: '/worktree-1' });

    expect(result.items[0]).toMatchObject({
      path: 'src/api/route.ts',
      rank: 1,
      attentionScore: 0.2,
      lens: 'interface_contract',
    });
    expect(result.items.slice(1).every((item) => item.attentionScore === null)).toBe(true);
  });

  it('keeps receipts in their lane and repository even when the graph is identical', async () => {
    const evidence = { ...graph, analysisId: 'analysis-shared-graph' };
    h.askJudgment.mockImplementation(async (request: { context: { laneId: string | null } }) => ({
      answers: {},
      model: 'jev-latest',
      usage: { inputTokens: 10, outputTokens: 5 },
      latencyMs: 100,
      attempts: 1,
      receiptId: `receipt-${request.context.laneId ?? 'workspace'}-${h.askJudgment.mock.calls.length}`,
    }));

    const first = await rankArchitectureAttention(evidence, { laneId: 'lane-a', repoPath: '/repo-a' });
    const second = await rankArchitectureAttention(evidence, { laneId: 'lane-b', repoPath: '/repo-a' });
    const otherRepo = await rankArchitectureAttention(evidence, { repoPath: '/repo-b' });
    const otherWorkspace = await rankArchitectureAttention(evidence, { repoPath: '/repo-c' });
    const repeated = await rankArchitectureAttention(evidence, { laneId: 'lane-a', repoPath: '/repo-a' });

    expect(h.askJudgment).toHaveBeenCalledTimes(4);
    expect(h.askJudgment.mock.calls.map(([request]) => request.context.laneId)).toEqual([
      'lane-a', 'lane-b', null, null,
    ]);
    expect(first.receiptId).toBe('receipt-lane-a-1');
    expect(second.receiptId).toBe('receipt-lane-b-2');
    expect(otherRepo.receiptId).toBe('receipt-workspace-3');
    expect(otherWorkspace.receiptId).toBe('receipt-workspace-4');
    expect(repeated).toMatchObject({ receiptId: first.receiptId, cached: true });
  });
});
