import { describe, expect, it } from 'vitest';

import {
  isSignedOutEntitlementRefresh,
  shouldUseSignedOutEntitlement,
} from './context';

describe('entitlement client session truth', () => {
  it('drops to free only when Clerk has resolved a signed-out session', () => {
    expect(shouldUseSignedOutEntitlement({ clerkEnabled: true, isLoaded: true, signedIn: false })).toBe(true);
    expect(shouldUseSignedOutEntitlement({ clerkEnabled: true, isLoaded: false, signedIn: false })).toBe(false);
    expect(shouldUseSignedOutEntitlement({ clerkEnabled: false, isLoaded: true, signedIn: false })).toBe(false);
    expect(shouldUseSignedOutEntitlement({ clerkEnabled: true, isLoaded: true, signedIn: true })).toBe(false);
  });

  it('recognizes the existing entitlement refresh event as an immediate sign-out clear', () => {
    expect(isSignedOutEntitlementRefresh({ signedOut: true })).toBe(true);
    expect(isSignedOutEntitlementRefresh({ signedOut: false })).toBe(false);
    expect(isSignedOutEntitlementRefresh(undefined)).toBe(false);
  });
});
