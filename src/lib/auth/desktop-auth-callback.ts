import { clearDesktopAuthError, reportDesktopAuthError } from '@/lib/auth/desktop-auth-error';

export interface DesktopAuthSignIn {
  status?: string | null;
  createdSessionId?: string | null;
  ticket: (params: { ticket: string }) => Promise<{ error?: unknown }>;
  finalize: () => Promise<{ error?: unknown }>;
}

export interface DesktopAuthClerk {
  setActive: (params: { session: string }) => Promise<unknown>;
  user?: { reload?: () => Promise<unknown> } | null;
}

export interface ConsumeDesktopAuthCallbackOptions {
  signIn: DesktopAuthSignIn;
  clerk: DesktopAuthClerk;
  getExpectedState: () => string | null;
  clearExpectedState: () => void;
  retrySignIn?: () => void;
  /**
   * Fired once, after a fresh ticket sign-in fully activates. The handler uses
   * this to retire the server-side sign-out marker so it can't reject the
   * follow-up license sync as stale (#1483). Best-effort — its failure never
   * fails an otherwise-successful sign-in.
   */
  onSignInComplete?: () => void | Promise<void>;
}

// Module-level so remounts cannot reset the one-time-ticket guard.
const consumedTickets = new Set<string>();

export function resetConsumedDesktopAuthTicketsForTest(): void {
  consumedTickets.clear();
}

function reasonFromUnknown(value: unknown, fallback: string): string {
  if (!value) return fallback;
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message || fallback;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['longMessage', 'message', 'detail', 'error']) {
      const candidate = record[key];
      if (typeof candidate === 'string' && candidate.trim()) return candidate;
    }
  }
  return fallback;
}

function regenerateDesktopSignIn(options: ConsumeDesktopAuthCallbackOptions): void {
  try {
    options.retrySignIn?.();
  } catch (error) {
    console.error('[auth] failed to regenerate desktop sign-in:', error);
  }
}

export async function consumeDesktopAuthCallback(
  raw: string,
  options: ConsumeDesktopAuthCallbackOptions,
): Promise<void> {
  let ticket: string | null = null;
  let state: string | null = null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'o8:' || url.host !== 'auth') return;
    ticket = url.searchParams.get('ticket');
    state = url.searchParams.get('state');
  } catch {
    return;
  }

  if (!ticket) return;
  if (consumedTickets.has(ticket)) {
    reportDesktopAuthError('This sign-in link was already used. Try signing in again.');
    regenerateDesktopSignIn(options);
    return;
  }

  const expected = options.getExpectedState();
  if (expected && state !== expected) {
    console.warn('[auth] callback state mismatch — ignoring');
    reportDesktopAuthError('The sign-in response did not match this app session. Try signing in again.');
    regenerateDesktopSignIn(options);
    return;
  }

  consumedTickets.add(ticket);
  try {
    const { error } = await options.signIn.ticket({ ticket });
    if (error) {
      const reason = reasonFromUnknown(error, 'The sign-in ticket could not be exchanged.');
      console.error('[auth] ticket sign-in failed:', error);
      reportDesktopAuthError(reason);
      regenerateDesktopSignIn(options);
      return;
    }

    if (options.signIn.status !== 'complete') {
      const status = options.signIn.status || 'unknown';
      console.warn('[auth] ticket sign-in incomplete:', status);
      reportDesktopAuthError(`Clerk returned an incomplete sign-in status: ${status}.`);
      regenerateDesktopSignIn(options);
      return;
    }

    const { error: finalizeError } = await options.signIn.finalize();
    if (finalizeError) {
      const reason = reasonFromUnknown(finalizeError, 'The sign-in session could not be finalized.');
      console.error('[auth] finalize failed:', finalizeError);
      reportDesktopAuthError(reason);
      regenerateDesktopSignIn(options);
      return;
    }

    try {
      if (options.signIn.createdSessionId) {
        await options.clerk.setActive({ session: options.signIn.createdSessionId });
      }
      await options.clerk.user?.reload?.();
    } catch (activateErr) {
      const reason = reasonFromUnknown(activateErr, 'The signed-in session could not be activated.');
      console.error('[auth] post-finalize session activation failed:', activateErr);
      reportDesktopAuthError(reason);
      regenerateDesktopSignIn(options);
      return;
    }

    options.clearExpectedState();
    clearDesktopAuthError();
    // Sign-in is fully activated; retiring the sign-out marker is best-effort
    // and must not surface as a sign-in failure.
    await Promise.resolve(options.onSignInComplete?.()).catch(() => {});
  } catch (err) {
    const reason = reasonFromUnknown(err, 'The sign-in ticket exchange failed unexpectedly.');
    console.error('[auth] ticket exchange threw:', err);
    reportDesktopAuthError(reason);
    regenerateDesktopSignIn(options);
  }
}
