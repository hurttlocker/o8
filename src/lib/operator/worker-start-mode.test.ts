import { describe, expect, it } from 'vitest';

import { resolveWorkerHuddle, WORKER_START_OPTIONS } from './worker-start-mode';

describe('worker start mode', () => {
  const worker = {
    profile: 'codex-only' as const,
    runtime: 'codex' as const,
    model: 'gpt-5.6-terra',
  };

  it('runs autonomously by default, including lower-cost subscription workers', () => {
    expect(resolveWorkerHuddle({ ...worker, mode: 'autonomous' })).toBe(false);
    expect(resolveWorkerHuddle({ ...worker })).toBe(false);
  });

  it('supports explicit plan-first and adaptive policies', () => {
    expect(resolveWorkerHuddle({ ...worker, mode: 'huddle' })).toBe(true);
    expect(resolveWorkerHuddle({ ...worker, mode: 'adaptive' })).toBe(true);
  });

  it('keeps the three display rows aligned without human-gate language', () => {
    expect(WORKER_START_OPTIONS).toEqual([
      {
        value: 'autonomous',
        long: 'Code',
        short: 'Code',
        detail: 'Starts the worker immediately in its worktree.',
      },
      {
        value: 'huddle',
        long: 'Plan',
        short: 'Plan',
        detail: 'The worker reads the task, shares a plan with the lead, then waits before editing.',
      },
      {
        value: 'adaptive',
        long: 'Auto',
        short: 'Auto',
        detail: 'Uses Plan when the active worker profile requires it; otherwise starts work immediately.',
      },
    ]);

    const huddle = WORKER_START_OPTIONS.find((option) => option.value === 'huddle');
    expect(huddle).toBeDefined();
    expect(`${huddle?.long} ${huddle?.detail}`).not.toMatch(/\b(?:ask|approve|approval|confirm)\b/i);
  });

  it('lets a per-mission choice override the saved policy', () => {
    expect(resolveWorkerHuddle({ ...worker, mode: 'huddle', explicitHuddle: false })).toBe(false);
    expect(resolveWorkerHuddle({ ...worker, mode: 'autonomous', explicitHuddle: true })).toBe(true);
  });
});
