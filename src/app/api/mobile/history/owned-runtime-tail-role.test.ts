import { describe, expect, it } from 'vitest';
import { ownedRuntimeTailRole } from './owned-runtime-tail-role';

describe('ownedRuntimeTailRole', () => {
  it('treats a runtime message as assistant output even when its label is generic', () => {
    expect(ownedRuntimeTailRole('message', 'Runtime 2')).toBe('assistant');
  });

  it('preserves explicit roles for non-message tail entries', () => {
    expect(ownedRuntimeTailRole('event', 'User')).toBe('user');
    expect(ownedRuntimeTailRole('tool', 'Tool')).toBe('tool');
    expect(ownedRuntimeTailRole('event', 'Step complete')).toBe('system');
  });
});
