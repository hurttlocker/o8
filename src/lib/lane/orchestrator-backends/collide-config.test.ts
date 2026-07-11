import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveCollideConfig } from './collide-config';

// The aggregator setting defaults to 'auto' (picks the family from the composer
// backend). These tests exercise the baseModel path added 2026-07-11 — Collide's
// aggregator is the model the operator actually picked, when it belongs to the
// aggregator's family.
describe('resolveCollideConfig — chosen model becomes the aggregator', () => {
  const savedProposers = process.env.O8_COLLIDE_PROPOSERS;
  const savedAggregator = process.env.O8_COLLIDE_AGGREGATOR;
  beforeEach(() => {
    delete process.env.O8_COLLIDE_PROPOSERS;
    delete process.env.O8_COLLIDE_AGGREGATOR;
  });
  afterEach(() => {
    if (savedProposers === undefined) delete process.env.O8_COLLIDE_PROPOSERS; else process.env.O8_COLLIDE_PROPOSERS = savedProposers;
    if (savedAggregator === undefined) delete process.env.O8_COLLIDE_AGGREGATOR; else process.env.O8_COLLIDE_AGGREGATOR = savedAggregator;
  });

  it('runs the chosen Codex model as the aggregator when the composer backend is codex', () => {
    const cfg = resolveCollideConfig('codex', 'gpt-5.6-terra');
    expect(cfg.aggregator.backend).toBe('codex');
    expect(cfg.aggregator.model).toBe('gpt-5.6-terra');
  });

  it('runs the chosen Claude/Fable model as the aggregator on the claude family', () => {
    const cfg = resolveCollideConfig('fable', 'claude-fable-5');
    expect(cfg.aggregator.backend).toBe('claude');
    expect(cfg.aggregator.model).toBe('claude-fable-5');
  });

  it('never hands a cross-family model to the aggregator (codex backend, claude id → codex default)', () => {
    const cfg = resolveCollideConfig('codex', 'claude-opus-4-8');
    expect(cfg.aggregator.backend).toBe('codex');
    expect(cfg.aggregator.model).not.toMatch(/^claude/);
  });

  it('defaults to the claude family when no composer backend is chosen (auto)', () => {
    const cfg = resolveCollideConfig(undefined, undefined);
    expect(cfg.aggregator.backend).toBe('claude');
  });
});
