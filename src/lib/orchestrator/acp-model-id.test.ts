/**
 * Shape gate for discovered ACP model ids.
 *
 * Every "valid" case below is a REAL id from the live opencode 1.4.3 catalogue,
 * so the gate is proven against ids that actually have to pass, not against
 * strings shaped the way I imagined ids look.
 */

import { describe, it, expect } from 'vitest';

import { isPlausibleAcpModelId, normalizeAcpModelId } from './acp-model-id';
import LIVE_MODELS from './__fixtures__/opencode-1.4.3-models.json';

describe('isPlausibleAcpModelId', () => {
  it('accepts every id in the live catalogue', () => {
    const rejected = (LIVE_MODELS as Array<{ value: string }>)
      .map((o) => o.value)
      .filter((id) => !isPlausibleAcpModelId(id));
    // A gate that rejects a real id makes a model unselectable in Settings.
    expect(rejected).toEqual([]);
  });

  it('accepts the shapes the catalogue actually contains', () => {
    for (const id of [
      'opencode/big-pickle',
      'google/gemini-3-pro-image/high',
      'openrouter/deepseek/deepseek-v4-pro',
      'openrouter/nvidia/nemotron-3.5-content-safety:free',
      'xai/grok-4.5',
    ]) {
      expect(isPlausibleAcpModelId(id)).toBe(true);
    }
  });

  it('rejects non-strings and blanks', () => {
    for (const bad of [null, undefined, 42, {}, [], '', '   ']) {
      expect(isPlausibleAcpModelId(bad)).toBe(false);
    }
  });

  it('rejects malformed slash structure', () => {
    for (const bad of ['/leading', 'trailing/', 'double//slash']) {
      expect(isPlausibleAcpModelId(bad)).toBe(false);
    }
  });

  it('rejects whitespace and control characters', () => {
    for (const bad of ['open router/model', 'model\nname', 'model\tname', 'a b']) {
      expect(isPlausibleAcpModelId(bad)).toBe(false);
    }
  });

  it('rejects an absurdly long id', () => {
    expect(isPlausibleAcpModelId(`a/${'x'.repeat(500)}`)).toBe(false);
  });
});

describe('normalizeAcpModelId', () => {
  it('trims surrounding whitespace on an otherwise valid id', () => {
    expect(normalizeAcpModelId('  opencode/big-pickle  ')).toBe('opencode/big-pickle');
  });

  it('returns null rather than throwing for junk', () => {
    for (const bad of [null, undefined, 42, '', 'has space', '/bad']) {
      expect(normalizeAcpModelId(bad)).toBeNull();
    }
  });
});
