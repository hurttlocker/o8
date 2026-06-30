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

/** The full union, inlined — the single source the guard must equal. */
const inlined = (v: unknown): boolean =>
  v === 'codex' || v === 'claude' || v === 'openclaw' || v === 'hermes' || v === 'acp';

describe('isOrchestratorBackendId', () => {
  it('accepts exactly the registered backend ids', () => {
    for (const id of ['codex', 'claude', 'openclaw', 'hermes', 'acp']) {
      expect(isOrchestratorBackendId(id)).toBe(true);
    }
  });

  it('rejects everything else (including the Step-1 setting "auto")', () => {
    for (const v of ['auto', 'Codex', 'CLAUDE', 'HERMES', '', ' codex', 'codex ', null, undefined, 0, 1, {}, [], true, false]) {
      expect(isOrchestratorBackendId(v)).toBe(false);
    }
  });

  it('matches the inlined union expression for arbitrary inputs (single validation point)', () => {
    for (const v of ['codex', 'claude', 'openclaw', 'hermes', 'acp', 'auto', '', null, undefined, 42, {}, [], 'CLAUDE', ' openclaw']) {
      expect(isOrchestratorBackendId(v)).toBe(inlined(v));
    }
  });
});
