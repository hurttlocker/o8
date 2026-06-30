/**
 * Collide (MoA) fusion engine — Step 9 tests. Drives the engine with mock
 * proposers + a mock aggregator (no real CLIs) and asserts the fusion contract:
 *   (a) exactly ONE aggregator turn fires
 *   (b) the aggregator message contains BOTH proposals
 *   (c) proposers ran permissionMode:'plan' + toolProfile:'propose'
 *   (d) a proposer that emits a write/dispatch tool_use is caught + quarantined —
 *       its content can NEVER reach the aggregator (the lockout regression guard)
 *   (e) proposers are mutually independent (distinct side-thread ids)
 *   (f) only the aggregator streams as the visible answer (proposer text rides
 *       collide_proposal, not text)
 */

import { describe, it, expect } from 'vitest';

import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';
import { buildAggregatorMessage, looksLikeClaudeCapError, makeMoaBackend, type MoaConfig, type MoaProposal } from './moa';
import type { MoaDeps } from './moa';
import type { OrchestratorBackend, OrchestratorBackendId, OrchestratorTurnOptions } from './types';

interface MockCall {
  message: string;
  options: OrchestratorTurnOptions | undefined;
}

function mockBackend(
  id: OrchestratorBackendId,
  calls: MockCall[],
  script: (call: MockCall) => OrchestratorEvent[],
): OrchestratorBackend {
  return {
    id,
    label: id,
    peekSession: () => null,
    ensureSession: () => ({ sessionName: `${id}-sess`, status: 'ready' }),
    async sendTurn(_repoPath, message, onEvent, options) {
      const call: MockCall = { message, options };
      calls.push(call);
      for (const event of script(call)) onEvent(event);
    },
  };
}

const CONFIG: MoaConfig = {
  id: 'collide',
  label: 'Collide',
  proposers: [
    { backend: 'claude', model: 'm-claude' },
    { backend: 'codex', model: 'm-codex' },
  ],
  aggregator: { backend: 'claude', model: 'm-agg' },
};

const MAIN_THREAD = 'thoughts-test';
const isProposerCall = (c: MockCall) => Boolean(c.options?.threadId?.includes('::collide-propose::'));
const isAggregatorCall = (c: MockCall) => c.options?.threadId === MAIN_THREAD;

function setup(opts: {
  claudeProposal?: string;
  codexEvents?: OrchestratorEvent[];
  aggregatorText?: string;
}) {
  const claudeCalls: MockCall[] = [];
  const codexCalls: MockCall[] = [];

  // Claude is BOTH a proposer (side-thread) and the aggregator (main thread) —
  // one backend, distinguished by threadId. That IS the structural independence.
  const claude = mockBackend('claude', claudeCalls, (call) =>
    isProposerCall(call)
      ? [{ type: 'text', text: opts.claudeProposal ?? 'CLAUDE_PROPOSAL' }, { type: 'done', sessionId: 'c1', cost: null }]
      : [{ type: 'text', text: opts.aggregatorText ?? 'SYNTHESIZED ANSWER' }, { type: 'done', sessionId: 'agg', cost: null }],
  );
  const codex = mockBackend('codex', codexCalls, () =>
    opts.codexEvents ?? [{ type: 'text', text: 'CODEX_PROPOSAL' }, { type: 'done', sessionId: 'x1', cost: null }],
  );

  const deps: MoaDeps = { resolveBackend: (id) => (id === 'codex' ? codex : claude) };
  const backend = makeMoaBackend(CONFIG, deps);
  return { backend, claudeCalls, codexCalls };
}

describe('Collide fusion engine', () => {
  it('(a) fires exactly ONE aggregator turn, and one turn per proposer', async () => {
    const { backend, claudeCalls, codexCalls } = setup({});
    await backend.sendTurn('/repo', 'build X', () => {}, { threadId: MAIN_THREAD });

    expect(claudeCalls.filter(isAggregatorCall)).toHaveLength(1);
    expect(claudeCalls.filter(isProposerCall)).toHaveLength(1); // Claude proposer
    expect(codexCalls.filter(isProposerCall)).toHaveLength(1); // Codex proposer
    expect(codexCalls.filter(isAggregatorCall)).toHaveLength(0);
  });

  it('(b) the aggregator message contains BOTH proposals', async () => {
    const { backend, claudeCalls } = setup({ claudeProposal: 'CLAUDE_SAYS_FOO' });
    await backend.sendTurn('/repo', 'build X', () => {}, { threadId: MAIN_THREAD });

    const agg = claudeCalls.find(isAggregatorCall)!;
    expect(agg.message).toContain('CLAUDE_SAYS_FOO');
    expect(agg.message).toContain('CODEX_PROPOSAL');
    expect(agg.message).toContain('build X'); // original intent preserved
  });

  it('(c) proposers run read-only: permissionMode:plan + toolProfile:propose', async () => {
    const { backend, claudeCalls, codexCalls } = setup({});
    await backend.sendTurn('/repo', 'build X', () => {}, { threadId: MAIN_THREAD });

    for (const c of [...claudeCalls, ...codexCalls].filter(isProposerCall)) {
      expect(c.options?.permissionMode).toBe('plan');
      expect(c.options?.toolProfile).toBe('propose');
    }
    // The aggregator is NOT read-only — it honors the composer chip + keeps full tools.
    const agg = claudeCalls.find(isAggregatorCall)!;
    expect(agg.options?.toolProfile).toBeUndefined(); // defaults to 'full'
  });

  it('(d) a proposer write/dispatch tool_use is caught + quarantined — never reaches the aggregator', async () => {
    // Codex proposer goes rogue: emits a Write tool_use.
    const events: OrchestratorEvent[] = [];
    const { backend, claudeCalls } = setup({
      codexEvents: [
        { type: 'text', text: 'CODEX_SECRET_PLAN' },
        { type: 'tool_use', id: 't1', name: 'Write', input: { path: 'evil.ts' } },
        { type: 'text', text: 'MORE_AFTER_BREACH' },
      ],
    });
    await backend.sendTurn('/repo', 'build X', (e) => events.push(e), { threadId: MAIN_THREAD });

    // The breached proposal is surfaced as a breach + its text NEVER reaches the aggregator.
    const breachEvent = events.find((e) => e.type === 'collide_proposal' && e.breach) as
      | Extract<OrchestratorEvent, { type: 'collide_proposal' }>
      | undefined;
    expect(breachEvent).toBeDefined();
    expect(breachEvent!.proposer).toBe('Codex');

    const agg = claudeCalls.find(isAggregatorCall)!;
    expect(agg.message).not.toContain('CODEX_SECRET_PLAN'); // quarantined
    expect(agg.message).not.toContain('MORE_AFTER_BREACH');
    expect(agg.message).toContain('excluded'); // shows the proposer was dropped
    // The turn still completes — the trusted aggregator runs exactly once.
    expect(claudeCalls.filter(isAggregatorCall)).toHaveLength(1);
  });

  it('(e) proposers are independent — distinct side-thread ids, separate from main', async () => {
    const { backend, claudeCalls, codexCalls } = setup({});
    await backend.sendTurn('/repo', 'build X', () => {}, { threadId: MAIN_THREAD });

    const claudeProp = claudeCalls.find(isProposerCall)!.options?.threadId;
    const codexProp = codexCalls.find(isProposerCall)!.options?.threadId;
    expect(claudeProp).toBe('thoughts-test::collide-propose::claude');
    expect(codexProp).toBe('thoughts-test::collide-propose::codex');
    expect(claudeProp).not.toBe(codexProp);
    expect(claudeProp).not.toBe(MAIN_THREAD);
  });

  it('(f) only the aggregator streams as the visible answer; composer model overrides aggregator', async () => {
    const events: OrchestratorEvent[] = [];
    const { backend, claudeCalls } = setup({ aggregatorText: 'THE_ONLY_VISIBLE_ANSWER' });
    await backend.sendTurn('/repo', 'build X', (e) => events.push(e), {
      threadId: MAIN_THREAD,
      model: 'composer-picked-model',
      permissionMode: 'plan',
    });

    // proposer text rode collide_proposal; the ONLY `text` events are the aggregator's.
    const textEvents = events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text);
    expect(textEvents).toEqual(['THE_ONLY_VISIBLE_ANSWER']);
    expect(events.some((e) => e.type === 'collide_proposal')).toBe(true);
    expect(events.some((e) => e.type === 'collide_phase')).toBe(true);

    // The composer's model + permission chip flow to the aggregator (override config).
    const agg = claudeCalls.find(isAggregatorCall)!;
    expect(agg.options?.model).toBe('composer-picked-model');
    expect(agg.options?.permissionMode).toBe('plan');
  });
});

describe('buildAggregatorMessage', () => {
  it('labels the aggregator-self proposal vs the second opinion', () => {
    const proposals: MoaProposal[] = [
      { proposer: 'Claude', backendId: 'claude', text: 'pass A', breach: false, capped: false },
      { proposer: 'Codex', backendId: 'codex', text: 'pass B', breach: false, capped: false },
    ];
    const msg = buildAggregatorMessage('do the thing', proposals, 'claude');
    expect(msg).toContain('Your own first independent pass (Claude)');
    expect(msg).toContain('Independent second opinion (Codex)');
    expect(msg).toContain('pass A');
    expect(msg).toContain('pass B');
  });

  it('quarantines a breached proposal body', () => {
    const proposals: MoaProposal[] = [
      { proposer: 'Codex', backendId: 'codex', text: 'SHOULD_NOT_APPEAR', breach: true, capped: false },
    ];
    const msg = buildAggregatorMessage('x', proposals, 'claude');
    expect(msg).not.toContain('SHOULD_NOT_APPEAR');
    expect(msg).toContain('excluded');
  });
});

describe('Collide cap-degrade (never auto-metered)', () => {
  it('rewrites an aggregator cap error to the clean "Collide paused" notice', async () => {
    const claudeCalls: MockCall[] = [];
    const codexCalls: MockCall[] = [];
    // Aggregator (main thread) hits the weekly cap; proposer turns are fine.
    const claude = mockBackend('claude', claudeCalls, (call) =>
      isProposerCall(call)
        ? [{ type: 'text', text: 'CLAUDE_PROPOSAL' }, { type: 'done', sessionId: 'c1', cost: null }]
        : [{ type: 'error', error: 'Claude usage limit reached — resets in 3 days' }, { type: 'done', sessionId: 'agg', cost: null }],
    );
    const codex = mockBackend('codex', codexCalls, () => [{ type: 'text', text: 'CODEX_PROPOSAL' }, { type: 'done', sessionId: 'x1', cost: null }]);
    const deps: MoaDeps = { resolveBackend: (id) => (id === 'codex' ? codex : claude) };

    const events: OrchestratorEvent[] = [];
    await makeMoaBackend(CONFIG, deps).sendTurn('/repo', 'build X', (e) => events.push(e), { threadId: MAIN_THREAD });

    const errors = events.filter((e) => e.type === 'error').map((e) => (e as { error: string }).error);
    expect(errors.some((e) => e.includes('Collide paused'))).toBe(true);
    // The raw cap string never reaches the user; the clean notice replaces it.
    expect(errors.some((e) => e.includes('usage limit reached'))).toBe(false);
    // And it explicitly states o8 will not auto-meter (#1066).
    expect(errors.some((e) => e.includes('will not auto-switch to the metered API'))).toBe(true);
  });

  it('detects a Claude cap heuristically', () => {
    expect(looksLikeClaudeCapError('Claude usage limit reached')).toBe(true);
    expect(looksLikeClaudeCapError('429 Too Many Requests')).toBe(true);
    expect(looksLikeClaudeCapError('weekly limit hit')).toBe(true);
    expect(looksLikeClaudeCapError('file not found')).toBe(false);
  });
});
