/**
 * Account boundary for desktop capabilities.
 *
 * Local work is the default product. An o8 account is requested only when the
 * user crosses into account-portable or o8-hosted infrastructure.
 */
export type O8Capability =
  | 'workspace.local'
  | 'provider.local'
  | 'provider.byok'
  | 'github.local'
  | 'inference.install-allowance'
  | 'inference.account-managed'
  | 'entitlement.portable'
  | 'github.managed'
  | 'sync.account'
  | 'relay.off-network'
  | 'team.shared'
  | 'cloud.runners';

const ACCOUNT_REQUIRED = new Set<O8Capability>([
  'inference.account-managed',
  'entitlement.portable',
  'github.managed',
  'sync.account',
  'relay.off-network',
  'team.shared',
  'cloud.runners',
]);

export function capabilityRequiresO8Account(capability: O8Capability): boolean {
  return ACCOUNT_REQUIRED.has(capability);
}

export function requestO8Capability(input: {
  capability: O8Capability;
  signedIn: boolean;
  onAccountRequired: () => void;
  onReady: () => void;
}): 'ready' | 'account-required' {
  if (capabilityRequiresO8Account(input.capability) && !input.signedIn) {
    input.onAccountRequired();
    return 'account-required';
  }
  input.onReady();
  return 'ready';
}
