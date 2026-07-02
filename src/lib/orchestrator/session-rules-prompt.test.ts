/**
 * Per-turn session-rule injection (#1329) — the load-bearing mechanic.
 *
 * `withSessionRules` is what `ws-server.ts` calls on EVERY orchestrator turn
 * before handing the message to `backend.sendTurn`, so these tests pin:
 *   - the "Operator session rules (binding)" block is present when the thread
 *     has active rules (per-turn re-injection — rules survive context churn),
 *   - the message passes through untouched when there are no rules,
 *   - the block format is clearly delimited and lists every rule.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

// db/index.ts resolves the data dir at module load — set it BEFORE importing.
process.env.CORTEX_IDE_DATA_DIR = mkdtempSync(join(os.tmpdir(), 'o8-rules-prompt-'));

const { addSessionRule } = await import('@/lib/db/session-rules-store');
const { formatSessionRulesBlock, buildSessionRulesBlock, withSessionRules } = await import('./session-rules-prompt');

describe('formatSessionRulesBlock (pure formatter)', () => {
  it('returns null for an empty / blank-only rule list', () => {
    expect(formatSessionRulesBlock([])).toBeNull();
    expect(formatSessionRulesBlock(['  ', ''])).toBeNull();
  });

  it('wraps rules in the delimited binding envelope, one bullet per rule', () => {
    const block = formatSessionRulesBlock(['deprioritize speed', 'no workarounds']);
    expect(block).toContain('<Operator session rules (binding)>');
    expect(block).toContain('</Operator session rules (binding)>');
    expect(block).toContain('- deprioritize speed');
    expect(block).toContain('- no workarounds');
  });
});

describe('per-turn injection (withSessionRules)', () => {
  it('is the identity when the thread has no rules', () => {
    expect(withSessionRules('hello', 'thoughts-empty')).toBe('hello');
    expect(withSessionRules('hello', null)).toBe('hello');
    expect(withSessionRules('hello', undefined)).toBe('hello');
  });

  it('prepends the binding block on every call once rules exist (re-injection)', () => {
    addSessionRule('thoughts-turn', 'genuine solutions only');
    const turn1 = withSessionRules('first user message', 'thoughts-turn');
    const turn2 = withSessionRules('second user message', 'thoughts-turn');
    for (const turn of [turn1, turn2]) {
      expect(turn).toContain('<Operator session rules (binding)>');
      expect(turn).toContain('- genuine solutions only');
    }
    expect(turn1.endsWith('first user message')).toBe(true);
    expect(turn2.endsWith('second user message')).toBe(true);
  });

  it('never leaks another thread\'s rules into a turn', () => {
    addSessionRule('thoughts-leak-src', 'private to source thread');
    expect(withSessionRules('msg', 'thoughts-leak-other')).toBe('msg');
  });

  // In-band dispatch teaching — the mechanism that makes worker inheritance
  // reachable end-to-end: nothing else ever tells the model its own thread id,
  // so the turn block must carry the id + the create_mission instruction.
  it('teaches the model its thread id + the orchestratorThreadId dispatch arg', () => {
    addSessionRule('thoughts-teach', 'a binding rule');
    const turn = withSessionRules('user msg', 'thoughts-teach');
    expect(turn).toContain('orchestratorThreadId: "thoughts-teach"');
    expect(turn).toContain('create_mission');
  });

  it('keeps the teaching line OUT of worker-facing blocks (no teachDispatch)', () => {
    addSessionRule('thoughts-worker-block', 'a binding rule');
    const block = buildSessionRulesBlock('thoughts-worker-block');
    expect(block).toContain('- a binding rule');
    expect(block).not.toContain('orchestratorThreadId');
  });
});

describe('buildSessionRulesBlock', () => {
  it('returns null for blank / missing thread ids', () => {
    expect(buildSessionRulesBlock(null)).toBeNull();
    expect(buildSessionRulesBlock('')).toBeNull();
  });

  it('reads active rules from the store', () => {
    addSessionRule('thoughts-build', 'rule one');
    addSessionRule('thoughts-build', 'rule two');
    const block = buildSessionRulesBlock('thoughts-build');
    expect(block).toContain('- rule one');
    expect(block).toContain('- rule two');
  });
});
