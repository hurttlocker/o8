import { describe, expect, it, vi } from 'vitest';

import {
  capabilityRequiresO8Account,
  requestO8Capability,
} from './capabilities';

describe('desktop account capability boundary', () => {
  it('keeps local product capabilities account-free', () => {
    expect(capabilityRequiresO8Account('workspace.local')).toBe(false);
    expect(capabilityRequiresO8Account('provider.local')).toBe(false);
    expect(capabilityRequiresO8Account('provider.byok')).toBe(false);
    expect(capabilityRequiresO8Account('github.local')).toBe(false);
    expect(capabilityRequiresO8Account('inference.install-allowance')).toBe(false);
  });

  it('requires an account only at hosted and portable boundaries', () => {
    expect(capabilityRequiresO8Account('inference.account-managed')).toBe(true);
    expect(capabilityRequiresO8Account('entitlement.portable')).toBe(true);
    expect(capabilityRequiresO8Account('github.managed')).toBe(true);
    expect(capabilityRequiresO8Account('sync.account')).toBe(true);
    expect(capabilityRequiresO8Account('relay.off-network')).toBe(true);
    expect(capabilityRequiresO8Account('team.shared')).toBe(true);
    expect(capabilityRequiresO8Account('cloud.runners')).toBe(true);
  });

  it('starts direct GitHub connection without invoking account sign-in', () => {
    const signIn = vi.fn();
    const start = vi.fn();
    const result = requestO8Capability({
      capability: 'github.local',
      signedIn: false,
      onAccountRequired: signIn,
      onReady: start,
    });

    expect(result).toBe('ready');
    expect(start).toHaveBeenCalledOnce();
    expect(signIn).not.toHaveBeenCalled();
  });
});
