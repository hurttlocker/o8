/**
 * One union, three consumers.
 *
 * This file exists because the copies drifted. By 2026-08-04 there were three
 * hand-maintained definitions of `OrchestratorBackendSetting`, and the Settings
 * one (`settings/dispatch-shared.tsx`) was three backends behind — it omitted
 * `fable`, `o8`, and `opencode`, so a backend the composer could select was
 * typed as invalid on the Settings side. Nothing failed; the segmented control
 * just rendered nothing selected.
 *
 * The imports below are the test: each consumer is pulled through its OWN
 * module path, so re-adding a local copy in any of them fails here.
 */

import { describe, it, expect } from 'vitest';

import {
  isOrchestratorBackendSetting,
  type OrchestratorBackendSetting,
} from './backend-setting';
import { isOrchestratorBackendSetting as fromServerDefaults } from './defaults-env';
import { isThoughtsOrchestratorBackendSetting } from '@/components/desktop/thoughts/operator-defaults';
import { isOrchestratorBackendId } from '@/lib/lane/orchestrator-backends/types';

const ALL: OrchestratorBackendSetting[] = [
  'auto', 'codex', 'claude', 'openclaw', 'hermes', 'collide', 'fable', 'o8', 'opencode',
];

describe('OrchestratorBackendSetting — one definition', () => {
  it('accepts every setting', () => {
    for (const value of ALL) expect(isOrchestratorBackendSetting(value)).toBe(true);
  });

  it('rejects junk', () => {
    for (const bad of ['', 'nope', 'CODEX', null, undefined, 7, {}]) {
      expect(isOrchestratorBackendSetting(bad)).toBe(false);
    }
  });

  it('the server re-export is the same predicate', () => {
    expect(fromServerDefaults).toBe(isOrchestratorBackendSetting);
  });

  it('the client (thoughts) re-export is the same predicate', () => {
    expect(isThoughtsOrchestratorBackendSetting).toBe(isOrchestratorBackendSetting);
  });

  it('every consumer agrees on every value — the drift that motivated this', () => {
    for (const value of ALL) {
      expect(fromServerDefaults(value), `server rejected ${value}`).toBe(true);
      expect(isThoughtsOrchestratorBackendSetting(value), `client rejected ${value}`).toBe(true);
    }
  });
});

describe('setting union vs backend-id union', () => {
  it("every setting except 'auto' names a real backend", () => {
    // 'auto' is a resolution instruction, not a backend — it must NOT be an id.
    expect(isOrchestratorBackendId('auto')).toBe(false);
    for (const value of ALL.filter((v) => v !== 'auto')) {
      expect(isOrchestratorBackendId(value), `${value} is a setting but not a backend id`).toBe(true);
    }
  });

  it("'acp' is a backend id with no setting — the generic escape hatch", () => {
    expect(isOrchestratorBackendId('acp')).toBe(true);
    expect(isOrchestratorBackendSetting('acp')).toBe(false);
  });
});
