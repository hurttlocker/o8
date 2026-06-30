/**
 * Guard consolidation (Step 3a) — zero behavior change.
 *
 * The 'codex'|'claude'|'openclaw' union was re-validated inline in ~3 spots
 * (ws-server resolveMsgBackendId, the chat-history route, mobile thread history).
 * isOrchestratorBackendId is the single point now. This proves it's BYTE-IDENTICAL
 * to the inlined literal it replaced, so repointing those callers changed nothing.
 */

import { describe, it, expect } from 'vitest';

import { isOrchestratorBackendId } from './types';

/** The exact expression that lived inline at every call site, pre-3a. */
const legacy = (v: unknown): boolean => v === 'codex' || v === 'claude' || v === 'openclaw';

describe('isOrchestratorBackendId', () => {
  it('accepts exactly the three existing ids', () => {
    expect(isOrchestratorBackendId('codex')).toBe(true);
    expect(isOrchestratorBackendId('claude')).toBe(true);
    expect(isOrchestratorBackendId('openclaw')).toBe(true);
  });

  it('rejects everything else (including the Step-1 "auto" and the not-yet-added "hermes")', () => {
    for (const v of ['auto', 'hermes', 'acp', 'Codex', 'CLAUDE', '', ' codex', 'codex ', null, undefined, 0, 1, {}, [], true, false]) {
      expect(isOrchestratorBackendId(v)).toBe(false);
    }
  });

  it('matches the legacy inlined expression for arbitrary inputs', () => {
    for (const v of ['codex', 'claude', 'openclaw', 'auto', 'hermes', 'acp', '', null, undefined, 42, {}, [], 'CLAUDE', ' openclaw']) {
      expect(isOrchestratorBackendId(v)).toBe(legacy(v));
    }
  });
});
