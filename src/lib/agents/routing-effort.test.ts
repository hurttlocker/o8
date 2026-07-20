/**
 * Worker reasoning-effort routing. Two must-proves:
 *  1. PARITY — no requested effort ⇒ selectedEffort/requestedEffort are null and
 *     nothing else changes (the blast radius is zero unless effort is set).
 *  2. PER-RUNTIME — effort is honored only for runtimes with a reasoning-effort
 *     surface (codex/claude-code); gemini/opencode → clean no-op (null).
 */

import { describe, it, expect } from 'vitest';

import { resolveWorkerRouting } from './routing';

describe('resolveWorkerRouting — effort parity (unset)', () => {
  it('no requested effort ⇒ both effort fields null, other fields unchanged', () => {
    const r = resolveWorkerRouting({});
    expect(r.requestedEffort).toBeNull();
    expect(r.selectedEffort).toBeNull();
    // Untouched: default codex selection, no model.
    expect(r.selectedRuntime).toBe('codex');
    expect(r.selectedModel).toBeNull();
  });

  it("'adaptive' is treated as no explicit effort (runtime default) ⇒ null", () => {
    const r = resolveWorkerRouting({ requestedRuntime: 'codex', requestedEffort: 'adaptive' });
    expect(r.selectedEffort).toBeNull();
  });

  it('a bogus effort value ⇒ null (fails safe to runtime default)', () => {
    const r = resolveWorkerRouting({ requestedRuntime: 'codex', requestedEffort: 'turbo' });
    expect(r.selectedEffort).toBeNull();
  });
});

describe('resolveWorkerRouting — effort per-runtime', () => {
  it('codex honors the effort', () => {
    const r = resolveWorkerRouting({ requestedRuntime: 'codex', requestedEffort: 'high' });
    expect(r.selectedEffort).toBe('high');
    expect(r.requestedEffort).toBe('high');
  });

  it('default (no runtime) → codex → effort honored', () => {
    expect(resolveWorkerRouting({ requestedEffort: 'low' }).selectedEffort).toBe('low');
  });

  it('gemini remains selected and treats effort as a clean no-op', () => {
    const r = resolveWorkerRouting({ requestedRuntime: 'gemini', requestedEffort: 'high' });
    expect(r.selectedRuntime).toBe('gemini');
    expect(r.selectedEffort).toBeNull();
    expect(r.requestedEffort).toBe('high');
  });

  it('opencode → no-op too', () => {
    const r = resolveWorkerRouting({ requestedRuntime: 'opencode', requestedEffort: 'max' });
    // opencode may fall back to codex if not dispatchable; either way effort is
    // only applied on an effort-capable runtime.
    expect(r.selectedEffort === null || (r.selectedRuntime === 'codex' && r.selectedEffort === 'max')).toBe(true);
  });
});

describe('resolveWorkerRouting — effort round-trip (persist → normalize)', () => {
  it('feeding requestedEffort back in re-derives the same selectedEffort', () => {
    const first = resolveWorkerRouting({ requestedRuntime: 'codex', requestedEffort: 'high' });
    // Simulate normalizeWorkerRouting: re-resolve from the persisted request.
    const restored = resolveWorkerRouting({
      requestedRuntime: first.requestedRuntime ?? undefined,
      requestedModel: first.requestedModel ?? undefined,
      requestedEffort: first.requestedEffort ?? undefined,
    });
    expect(restored.selectedEffort).toBe('high');
  });
});
