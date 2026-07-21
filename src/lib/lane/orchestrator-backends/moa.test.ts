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
  config?: MoaConfig;
  claudeEvents?: OrchestratorEvent[];
  claudeProposal?: string;
  codexEvents?: OrchestratorEvent[];
  aggregatorText?: string;
}) {
  const claudeCalls: MockCall[] = [];
  const codexCalls: MockCall[] = [];

  // Claude is BOTH a proposer (side-thread) and the aggregator (main thread) —
  // one backend, distinguished by threadId. That IS the structural independence.
  const claude = mockBackend('claude', claudeCalls, (call) =>
    isProposerCall(call) && opts.claudeEvents
      ? opts.claudeEvents
      : isProposerCall(call)
      ? [{ type: 'text', text: opts.claudeProposal ?? 'CLAUDE_PROPOSAL' }, { type: 'done', sessionId: 'c1', cost: null }]
      : [{ type: 'text', text: opts.aggregatorText ?? 'SYNTHESIZED ANSWER' }, { type: 'done', sessionId: 'agg', cost: null }],
  );
  const codex = mockBackend('codex', codexCalls, () =>
    opts.codexEvents ?? [{ type: 'text', text: 'CODEX_PROPOSAL' }, { type: 'done', sessionId: 'x1', cost: null }],
  );

  const deps: MoaDeps = { resolveBackend: (id) => (id === 'codex' ? codex : claude) };
  const backend = makeMoaBackend(opts.config ?? CONFIG, deps);
  return { backend, claudeCalls, codexCalls };
}

describe('Collide fusion engine', () => {
  it('runs only the configured aggregator when the composer selects Solo', async () => {
    const events: OrchestratorEvent[] = [];
    const { backend, claudeCalls, codexCalls } = setup({});

    await backend.sendTurn('/repo', 'work alone', (event) => events.push(event), {
      threadId: MAIN_THREAD,
      orchestrationMode: 'single',
    });

    expect(claudeCalls.filter(isAggregatorCall)).toHaveLength(1);
    expect(claudeCalls.filter(isProposerCall)).toHaveLength(0);
    expect(codexCalls).toHaveLength(0);
    expect(claudeCalls[0]?.message).toBe('work alone');
    expect(claudeCalls[0]?.options).toMatchObject({
      orchestrationMode: 'single',
      toolProfile: 'solo',
    });
    expect(events.some((event) => event.type === 'collide_phase')).toBe(false);
    expect(events.some((event) => event.type === 'collide_proposal')).toBe(false);
  });

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
    // Redacted at source — the breached proposer's buffered text never leaves the server.
    expect(breachEvent!.text).toBe('');

    const agg = claudeCalls.find(isAggregatorCall)!;
    expect(agg.message).not.toContain('CODEX_SECRET_PLAN'); // quarantined
    expect(agg.message).not.toContain('MORE_AFTER_BREACH');
    expect(agg.message).toContain('excluded'); // shows the proposer was dropped
    // The turn still completes — the trusted aggregator runs exactly once.
    expect(claudeCalls.filter(isAggregatorCall)).toHaveLength(1);
  });

  it('(d2) a proposer attempting cortex_launch_agent (the dispatch hole) aborts + is excluded', async () => {
    // THE finding: cortex is mixed; cortex_launch_agent dispatches a worker. A
    // proposer that calls it must be caught + quarantined, never reach synthesis.
    const events: OrchestratorEvent[] = [];
    const { backend, claudeCalls } = setup({
      codexEvents: [
        { type: 'text', text: 'CODEX_WANTS_TO_DISPATCH' },
        { type: 'tool_use', id: 't1', name: 'mcp__cortex__cortex_launch_agent', input: { task: 'go' } },
      ],
    });
    await backend.sendTurn('/repo', 'build X', (e) => events.push(e), { threadId: MAIN_THREAD });

    const breach = events.find((e) => e.type === 'collide_proposal' && e.breach) as
      | Extract<OrchestratorEvent, { type: 'collide_proposal' }> | undefined;
    expect(breach).toBeDefined();
    expect(breach!.text).toBe(''); // redacted
    const agg = claudeCalls.find(isAggregatorCall)!;
    expect(agg.message).not.toContain('CODEX_WANTS_TO_DISPATCH'); // quarantined out of synthesis
    expect(claudeCalls.filter(isAggregatorCall)).toHaveLength(1);
  });

  it('(d3) a proposer attempting an EXTERNAL MCP tool is caught + quarantined', async () => {
    // Externals (a user's Postgres/GitHub/Linear MCP) ride no proposer surface;
    // a proposer that emits one must be caught + excluded, never reach synthesis.
    const events: OrchestratorEvent[] = [];
    const { backend, claudeCalls } = setup({
      codexEvents: [
        { type: 'text', text: 'CODEX_WANTS_EXTERNAL' },
        { type: 'tool_use', id: 't1', name: 'mcp__github__create_issue', input: { title: 'x' } },
      ],
    });
    await backend.sendTurn('/repo', 'build X', (e) => events.push(e), { threadId: MAIN_THREAD });

    const breach = events.find((e) => e.type === 'collide_proposal' && e.breach) as
      | Extract<OrchestratorEvent, { type: 'collide_proposal' }> | undefined;
    expect(breach).toBeDefined();
    expect(breach!.text).toBe(''); // redacted
    const agg = claudeCalls.find(isAggregatorCall)!;
    expect(agg.message).not.toContain('CODEX_WANTS_EXTERNAL'); // quarantined out of synthesis
    expect(claudeCalls.filter(isAggregatorCall)).toHaveLength(1);
  });

  it('(d4) Codex aggregation excludes a Claude proposer that attempts dispatch', async () => {
    const events: OrchestratorEvent[] = [];
    const codexAggregates: MoaConfig = {
      ...CONFIG,
      aggregator: { backend: 'codex', model: 'm-codex-agg' },
    };
    const { backend, codexCalls } = setup({
      config: codexAggregates,
      claudeEvents: [
        { type: 'text', text: 'CLAUDE_WANTS_TO_DISPATCH' },
        { type: 'tool_use', id: 't1', name: 'mcp__cortex__cortex_launch_agent', input: { task: 'go' } },
      ],
    });
    await backend.sendTurn('/repo', 'build X', (e) => events.push(e), { threadId: MAIN_THREAD });

    const breach = events.find((e) => e.type === 'collide_proposal' && e.breach) as
      | Extract<OrchestratorEvent, { type: 'collide_proposal' }> | undefined;
    expect(breach).toBeDefined();
    expect(breach!.proposer).toBe('Claude');
    expect(breach!.text).toBe('');
    const agg = codexCalls.find(isAggregatorCall)!;
    expect(agg.message).not.toContain('CLAUDE_WANTS_TO_DISPATCH');
    expect(agg.message).toContain('excluded');
    expect(codexCalls.filter(isAggregatorCall)).toHaveLength(1);
  });

  it('(e) proposers are independent — distinct side-thread ids (indexed by position), separate from main', async () => {
    const { backend, claudeCalls, codexCalls } = setup({});
    await backend.sendTurn('/repo', 'build X', () => {}, { threadId: MAIN_THREAD });

    const claudeProp = claudeCalls.find(isProposerCall)!.options?.threadId;
    const codexProp = codexCalls.find(isProposerCall)!.options?.threadId;
    expect(claudeProp).toBe('thoughts-test::collide-propose::0-claude');
    expect(codexProp).toBe('thoughts-test::collide-propose::1-codex');
    expect(claudeProp).not.toBe(codexProp);
    expect(claudeProp).not.toBe(MAIN_THREAD);
  });

  it('(e2) two SAME-backend proposers get distinct threads (no shared-session race)', async () => {
    const calls: MockCall[] = [];
    const codex = mockBackend('codex', calls, () => [{ type: 'text', text: 'p' }, { type: 'done', sessionId: 's', cost: null }]);
    const deps: MoaDeps = { resolveBackend: () => codex };
    const twoCodex: MoaConfig = {
      id: 'collide', label: 'Collide',
      proposers: [{ backend: 'codex' }, { backend: 'codex' }],
      aggregator: { backend: 'codex' },
    };
    await makeMoaBackend(twoCodex, deps).sendTurn('/repo', 'X', () => {}, { threadId: MAIN_THREAD });
    const threads = calls.filter(isProposerCall).map((c) => c.options?.threadId);
    expect(threads).toEqual(['thoughts-test::collide-propose::0-codex', 'thoughts-test::collide-propose::1-codex']);
    expect(new Set(threads).size).toBe(2); // distinct — no race
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

  it('(g) a HANGING proposer times out — Collide still terminates + aggregates without it', async () => {
    const claudeCalls: MockCall[] = [];
    const codexCalls: MockCall[] = [];
    const claude = mockBackend('claude', claudeCalls, (call) =>
      isProposerCall(call)
        ? [{ type: 'text', text: 'CLAUDE_PROPOSAL' }, { type: 'done', sessionId: 'c1', cost: null }]
        : [{ type: 'text', text: 'SYNTHESIZED ANSWER' }, { type: 'done', sessionId: 'agg', cost: null }]);
    // Codex proposer HANGS — its sendTurn never resolves. The per-proposer
    // timeout must abort it and let Phase A finish.
    const codex: OrchestratorBackend = {
      id: 'codex', label: 'codex',
      peekSession: () => null,
      ensureSession: () => ({ sessionName: 'codex-sess', status: 'ready' }),
      sendTurn: (_repo, message, _onEvent, options) => {
        codexCalls.push({ message, options });
        return new Promise<void>(() => {}); // never resolves
      },
    };
    const deps: MoaDeps = { resolveBackend: (id) => (id === 'codex' ? codex : claude), proposerTimeoutMs: 30 };

    const events: OrchestratorEvent[] = [];
    // The whole point: this AWAIT must resolve (no hang), well under any real timeout.
    await makeMoaBackend(CONFIG, deps).sendTurn('/repo', 'build X', (e) => events.push(e), { threadId: MAIN_THREAD });

    // Terminated: the aggregator ran exactly once despite the hung proposer.
    expect(claudeCalls.filter(isAggregatorCall)).toHaveLength(1);
    const agg = claudeCalls.find(isAggregatorCall)!;
    expect(agg.message).toContain('CLAUDE_PROPOSAL');            // the proposer that returned
    expect(agg.message).toMatch(/timed out|excluded/i);         // the hung one marked excluded
    // The hung proposer still surfaced a (timed-out) collide_proposal card entry.
    expect(events.some((e) => e.type === 'collide_proposal' && e.proposer === 'Codex')).toBe(true);
  });
});

describe('buildAggregatorMessage', () => {
  it('labels the aggregator-self proposal vs the second opinion', () => {
    const proposals: MoaProposal[] = [
      { proposer: 'Claude', backendId: 'claude', text: 'pass A', breach: false, capped: false, timedOut: false },
      { proposer: 'Codex', backendId: 'codex', text: 'pass B', breach: false, capped: false, timedOut: false },
    ];
    const msg = buildAggregatorMessage('do the thing', proposals, 'claude');
    expect(msg).toContain('Your own first independent pass (Claude)');
    expect(msg).toContain('Independent second opinion (Codex)');
    expect(msg).toContain('pass A');
    expect(msg).toContain('pass B');
  });

  it('quarantines a breached proposal body', () => {
    const proposals: MoaProposal[] = [
      { proposer: 'Codex', backendId: 'codex', text: 'SHOULD_NOT_APPEAR', breach: true, capped: false, timedOut: false },
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
