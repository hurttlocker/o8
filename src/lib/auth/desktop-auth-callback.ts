import { clearDesktopAuthError, reportDesktopAuthError } from '@/lib/auth/desktop-auth-error';

export interface DesktopAuthSignIn {
  status?: string | null;
  createdSessionId?: string | null;
  ticket: (params: { ticket: string }) => Promise<{ error?: unknown }>;
  finalize: () => Promise<{ error?: unknown }>;
}

export interface DesktopAuthClerk {
  setActive: (params: { session: string }) => Promise<unknown>;
  user?: { id?: string; reload?: () => Promise<unknown> } | null;
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
let exchangingTickets = 0;
const exchangeListeners = new Set<() => void>();
const browserSignInListeners = new Set<() => void>();

export function subscribeDesktopBrowserSignIn(listener: () => void): () => void {
  browserSignInListeners.add(listener);
  return () => { browserSignInListeners.delete(listener); };
}

export function desktopAuthTicketExchangeInProgress(): boolean {
  return exchangingTickets > 0;
}

export function subscribeDesktopAuthTicketExchange(listener: () => void): () => void {
  exchangeListeners.add(listener);
  return () => { exchangeListeners.delete(listener); };
}

export function waitForDesktopAuthTicketExchange(): Promise<void> {
  if (!desktopAuthTicketExchangeInProgress()) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = subscribeDesktopAuthTicketExchange(() => {
      if (desktopAuthTicketExchangeInProgress()) return;
      unsubscribe();
      resolve();
    });
  });
}

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

/** Shared by the state-checked deep link and the server-issued device ticket. */
export async function exchangeDesktopAuthTicket(
  ticket: string,
  options: { signIn: DesktopAuthSignIn; clerk: DesktopAuthClerk; onActivated?: () => Promise<void> },
): Promise<void> {
  if (desktopAuthTicketExchangeInProgress()) {
    throw new Error('A desktop sign-in is already in progress. Try signing in again.');
  }
  exchangingTickets += 1;
  exchangeListeners.forEach((listener) => listener());
  try {
    const { error } = await options.signIn.ticket({ ticket });
    if (error) throw new Error(reasonFromUnknown(error, 'The sign-in ticket could not be exchanged.'));
    if (options.signIn.status !== 'complete') {
      throw new Error(`Clerk returned an incomplete sign-in status: ${options.signIn.status || 'unknown'}.`);
    }
    const { error: finalizeError } = await options.signIn.finalize();
    if (finalizeError) throw new Error(reasonFromUnknown(finalizeError, 'The sign-in session could not be finalized.'));
    try {
      if (options.signIn.createdSessionId) {
        await options.clerk.setActive({ session: options.signIn.createdSessionId });
      }
      await options.clerk.user?.reload?.();
    } catch (error) {
      throw new Error(reasonFromUnknown(error, 'The signed-in session could not be activated.'));
    }
    await options.onActivated?.();
  } finally {
    exchangingTickets -= 1;
    exchangeListeners.forEach((listener) => listener());
  }
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
    await exchangeDesktopAuthTicket(ticket, {
      ...options,
      onActivated: async () => {
        options.clearExpectedState();
        clearDesktopAuthError();
        // Retire the marker before the bridge can sync or enroll this session.
        await Promise.resolve(options.onSignInComplete?.()).catch(() => {});
        browserSignInListeners.forEach((listener) => listener());
      },
    });
  } catch (err) {
    const reason = reasonFromUnknown(err, 'The sign-in ticket exchange failed unexpectedly.');
    reportDesktopAuthError(reason);
    regenerateDesktopSignIn(options);
  }
}
