/**
 * Session rules store (#1329) — CRUD + thread scoping.
 *
 * Rules are ephemeral and thread-scoped BY DESIGN: a rule added to thread A
 * must never surface for thread B, and a removed rule must vanish from the
 * active list immediately. These tests pin that contract against a fresh
 * throwaway SQLite data dir.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

// db/index.ts resolves the data dir at module load — set it BEFORE importing.
process.env.CORTEX_IDE_DATA_DIR = mkdtempSync(join(os.tmpdir(), 'o8-session-rules-'));

const {
  addSessionRule,
  getSessionRule,
  listSessionRules,
  listSessionRuleTexts,
  removeSessionRule,
  SESSION_RULE_MAX_LEN,
} = await import('./session-rules-store');

describe('session-rules store CRUD + thread scoping', () => {
  it('adds a rule and reads it back with the thread key', () => {
    const rule = addSessionRule('thoughts-100', 'No workarounds — genuine solutions only.');
    expect(rule).not.toBeNull();
    expect(rule!.threadId).toBe('thoughts-100');
    expect(rule!.text).toBe('No workarounds — genuine solutions only.');
    expect(rule!.active).toBe(true);
    expect(getSessionRule(rule!.id)?.text).toBe('No workarounds — genuine solutions only.');
  });

  it('scopes rules to their thread — thread B never sees thread A rules', () => {
    addSessionRule('thoughts-A', 'rule for A');
    addSessionRule('thoughts-B', 'rule for B');
    const aTexts = listSessionRuleTexts('thoughts-A');
    const bTexts = listSessionRuleTexts('thoughts-B');
    expect(aTexts).toContain('rule for A');
    expect(aTexts).not.toContain('rule for B');
    expect(bTexts).toContain('rule for B');
    expect(bTexts).not.toContain('rule for A');
  });

  it('returns [] for an unknown or blank thread id (new thread = clean tier)', () => {
    expect(listSessionRules('thoughts-never-seen')).toEqual([]);
    expect(listSessionRules('')).toEqual([]);
    expect(listSessionRules('   ')).toEqual([]);
  });

  it('lists rules oldest-first (stable injection order)', () => {
    addSessionRule('thoughts-order', 'first');
    addSessionRule('thoughts-order', 'second');
    addSessionRule('thoughts-order', 'third');
    expect(listSessionRuleTexts('thoughts-order')).toEqual(['first', 'second', 'third']);
  });

  it('rejects blank text and blank thread id', () => {
    expect(addSessionRule('thoughts-x', '   ')).toBeNull();
    expect(addSessionRule('', 'some text')).toBeNull();
  });

  it('caps stored rule length', () => {
    const rule = addSessionRule('thoughts-cap', 'x'.repeat(SESSION_RULE_MAX_LEN + 500));
    expect(rule!.text.length).toBe(SESSION_RULE_MAX_LEN);
  });

  it('removes a rule by id and it disappears from the active list', () => {
    const rule = addSessionRule('thoughts-rm', 'temporary rule')!;
    expect(listSessionRuleTexts('thoughts-rm')).toContain('temporary rule');
    expect(removeSessionRule(rule.id)).toBe(true);
    expect(listSessionRuleTexts('thoughts-rm')).not.toContain('temporary rule');
    expect(removeSessionRule(rule.id)).toBe(false); // already gone
  });
});
