/**
 * opencode orchestrator backend — real-path registry + wire-shape tests.
 *
 * The reachability rule (CLAUDE.md) is why the first block drives
 * `getOrchestratorBackend` rather than asserting the export exists: the registry
 * resolves an unknown id to `DEFAULT_BACKEND` (codex). So a missing `BACKENDS`
 * row does NOT throw — every opencode turn would silently run on Codex, on the
 * exact subscription the operator switched away from. Asserting `.id` through
 * the real resolver is what catches that; importing `opencodeBackend` directly
 * would stay green with the registry row deleted.
 *
 * The parse block uses the VERBATIM `session/new` payload shape captured from
 * live opencode 1.4.3 (2026-08-04 spike), so a wire change breaks a test rather
 * than a picker.
 */

import { describe, it, expect } from 'vitest';

import { getOrchestratorBackend } from './registry';
import { isOrchestratorBackendId } from './types';
import { orchestratorBackendBillingClass } from './billing';
import { isOrchestratorBackendSetting } from '@/lib/operator/defaults-env';
import { isThoughtsOrchestratorBackendSetting } from '@/components/desktop/thoughts/operator-defaults';
import { parseConfigOptions } from '@/lib/acp/client';

describe('opencode backend — registry resolution (real path)', () => {
  it('resolves to the opencode backend, not the codex fallback', () => {
    const backend = getOrchestratorBackend('opencode');
    // The whole point: `?? DEFAULT_BACKEND` would hand back codex silently.
    expect(backend.id).toBe('opencode');
    expect(backend.label).toBe('opencode');
  });

  it('exposes the full OrchestratorBackend contract', () => {
    const backend = getOrchestratorBackend('opencode');
    expect(typeof backend.sendTurn).toBe('function');
    expect(typeof backend.ensureSession).toBe('function');
    expect(typeof backend.peekSession).toBe('function');
  });
});

describe('opencode backend — id + setting guards agree', () => {
  it('is a valid backend id', () => {
    expect(isOrchestratorBackendId('opencode')).toBe(true);
  });

  // Three parallel unions exist (backend id, server setting, client setting).
  // They drifted before; a backend valid in one and rejected by another is
  // unselectable in the UI while looking correct server-side.
  it('is accepted by BOTH the server and client setting guards', () => {
    expect(isOrchestratorBackendSetting('opencode')).toBe(true);
    expect(isThoughtsOrchestratorBackendSetting('opencode')).toBe(true);
  });

  it('bills as metered — it runs on the operator’s own provider keys', () => {
    expect(orchestratorBackendBillingClass('opencode')).toBe('metered');
  });
});

describe('opencode backend — session/new configOptions parsing', () => {
  // Verbatim shape from live opencode 1.4.3.
  const LIVE_PAYLOAD = {
    sessionId: 'ses_030e2162fffeBCg5m8pJMnfOEU',
    configOptions: [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'opencode/big-pickle',
        options: [
          { value: 'google/gemini-3-pro-image', name: 'Google/Nano Banana Pro' },
          { value: 'google/gemini-3-pro-image/low', name: 'Google/Nano Banana Pro (low)' },
          { value: 'google/gemini-3-pro-image/high', name: 'Google/Nano Banana Pro (high)' },
          { value: 'openrouter/deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
        ],
      },
      { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'build', options: [] },
    ],
  };

  it('keeps every model option and the current value', () => {
    const parsed = parseConfigOptions(LIVE_PAYLOAD.configOptions);
    const modelOption = parsed.find((o) => o.id === 'model');
    expect(parsed).toHaveLength(2);
    expect(modelOption?.currentValue).toBe('opencode/big-pickle');
    expect(modelOption?.options).toHaveLength(4);
    expect(modelOption?.type).toBe('select');
  });

  it('drops malformed entries instead of throwing', () => {
    const parsed = parseConfigOptions([
      { id: 'model', options: [{ value: 'a' }, { name: 'no value' }, null] },
      { name: 'missing id' },
      'not an object',
      null,
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].options).toEqual([{ value: 'a', name: undefined }]);
  });

  it('returns an empty array for a non-array payload', () => {
    expect(parseConfigOptions(undefined)).toEqual([]);
    expect(parseConfigOptions({ id: 'model' })).toEqual([]);
  });

  it('effort rides the model id as a /low|/high suffix', () => {
    const parsed = parseConfigOptions(LIVE_PAYLOAD.configOptions);
    const values = (parsed.find((o) => o.id === 'model')?.options ?? []).map((o) => o.value);
    const base = 'google/gemini-3-pro-image';
    const siblings = values.filter((v) => v === base || v.startsWith(`${base}/`));
    expect(siblings).toEqual([base, `${base}/low`, `${base}/high`]);
    // A model with no siblings has no effort axis — the picker must not invent one.
    const deepseek = values.filter((v) => v.startsWith('openrouter/deepseek/deepseek-v4-pro'));
    expect(deepseek).toHaveLength(1);
  });

  it('carries cross-house model ids — the whole reason this backend exists', () => {
    const parsed = parseConfigOptions(LIVE_PAYLOAD.configOptions);
    const values = (parsed.find((o) => o.id === 'model')?.options ?? []).map((o) => o.value);
    expect(values.some((v) => v.startsWith('openrouter/'))).toBe(true);
    expect(values.some((v) => v.startsWith('google/'))).toBe(true);
  });
});
