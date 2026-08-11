import { describe, expect, it } from 'vitest';

import { resolveWorkerHuddle } from './worker-start-mode';

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

  it('supports explicit ask-first and adaptive policies', () => {
    expect(resolveWorkerHuddle({ ...worker, mode: 'huddle' })).toBe(true);
    expect(resolveWorkerHuddle({ ...worker, mode: 'adaptive' })).toBe(true);
  });

  it('lets a per-mission choice override the saved policy', () => {
    expect(resolveWorkerHuddle({ ...worker, mode: 'huddle', explicitHuddle: false })).toBe(false);
    expect(resolveWorkerHuddle({ ...worker, mode: 'autonomous', explicitHuddle: true })).toBe(true);
  });
});
