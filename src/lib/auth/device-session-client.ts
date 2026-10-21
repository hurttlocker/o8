import { desktopAuthTicketExchangeInProgress, exchangeDesktopAuthTicket, type DesktopAuthClerk, type DesktopAuthSignIn } from '@/lib/auth/desktop-auth-callback';
import { clearDesktopAuthError } from '@/lib/auth/desktop-auth-error';

export const DEVICE_RETRY_MS = 5 * 60_000;

export type DeviceSessionTrigger = 'initial' | 'focus' | 'signed-out';

export interface DeviceSessionDecisionInput {
  nativeMode: boolean;
  loaded: boolean;
  userId: string | null;
  deviceOwner: string | null;
  explicitSignOut: boolean;
  busy: boolean;
  enrolled: boolean;
  retryAfter: number;
  now: number;
  trigger: DeviceSessionTrigger;
}

export function deviceSessionDecision(input: DeviceSessionDecisionInput): 'none' | 'enroll' | 'renew' {
  if (!input.nativeMode || !input.loaded || input.explicitSignOut || input.busy || input.now < input.retryAfter) return 'none';
  if (input.userId) {
    return !input.enrolled && input.deviceOwner !== input.userId ? 'enroll' : 'none';
  }
  return input.deviceOwner ? 'renew' : 'none';
}

/** Retire explicit-sign-out state before refreshing license and managed identity. */
export async function completeDesktopSignIn(sync?: () => Promise<void>): Promise<void> {
  const response = await fetch('/api/panel/entitlement/sync', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clearSignInMarker: true }),
  });
  const data = await response.json();
  if (!response.ok || data?.ok !== true) throw new Error('Sign-in completion failed.');
  await sync?.();
}

export async function renewDesktopSession(options: {
  owner: string;
  signIn: DesktopAuthSignIn;
  clerk: DesktopAuthClerk;
  isCurrent: () => boolean;
  signOut: () => Promise<void>;
  onSignInComplete: () => Promise<void>;
}): Promise<boolean> {
  const response = await fetch('/api/panel/auth/device/renew', { method: 'POST' });
  const data = await response.json();
  if (!options.isCurrent() || desktopAuthTicketExchangeInProgress()) return false;
  if (data?.reason === 'device_owner_mismatch' || (response.ok && data?.clerkUserId !== options.owner)) {
    await options.signOut();
    return false;
  }
  if (!response.ok || typeof data?.ticket !== 'string' || !data.ticket) {
    throw new Error('Device session renewal failed.');
  }
  let renewed = false;
  await exchangeDesktopAuthTicket(data.ticket, {
    ...options,
    onActivated: async () => {
      if (!options.isCurrent()) return;
      if (options.clerk.user?.id !== options.owner) {
        await options.signOut();
        return;
      }
      clearDesktopAuthError();
      await options.onSignInComplete();
      renewed = true;
    },
  });
  return renewed;
}
