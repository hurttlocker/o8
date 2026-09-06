import { describe, expect, it } from 'vitest';
import { codexCliSupportsUltraEfforts, resolveCodexReasoningEffort } from './reasoning-effort';

describe('codexCliSupportsUltraEfforts', () => {
  it('rejects pre-0.144 CLIs (the unknown-variant crash class)', () => {
    expect(codexCliSupportsUltraEfforts('codex-cli 0.136.0')).toBe(false);
  });
  it('accepts 0.144+', () => {
    expect(codexCliSupportsUltraEfforts('codex-cli 0.144.0')).toBe(true);
    expect(codexCliSupportsUltraEfforts('0.150.2')).toBe(true);
  });
  it('clamps on unknown/empty version', () => {
    expect(codexCliSupportsUltraEfforts(undefined)).toBe(false);
    expect(codexCliSupportsUltraEfforts('')).toBe(false);
  });
});

describe('resolveCodexReasoningEffort', () => {
  it('passes max and ultra through on Astra and Sol only', () => {
    expect(resolveCodexReasoningEffort('max', 'gpt-6-astra')).toBe('max');
    expect(resolveCodexReasoningEffort('ultra', 'gpt-6-astra')).toBe('ultra');
    expect(resolveCodexReasoningEffort('max', 'gpt-5.6-sol')).toBe('max');
    expect(resolveCodexReasoningEffort('max', 'gpt-5.5')).toBe('xhigh');
  });
});
