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
  /** Native handler validates and consumes its durable, one-time handoff nonce. */
  validateHandoff?: (state: string | null) => Promise<boolean>;
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
let handoffGeneration = 0;

export function desktopAuthHandoffGeneration(): number {
  return handoffGeneration;
}

export function invalidateDesktopAuthHandoffs(): void {
  handoffGeneration += 1;
}

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

// Only locally constructed messages may cross the auth error boundary. SDK
// errors can contain response bodies, callback URLs, tokens, stacks and causes.
class DesktopAuthFailure extends Error {}

/** Shared by the state-checked deep link and the server-issued device ticket. */
export async function exchangeDesktopAuthTicket(
  ticket: string,
  options: { signIn: DesktopAuthSignIn; clerk: DesktopAuthClerk; onActivated?: () => Promise<void>; isCurrent?: () => boolean },
): Promise<void> {
  if (desktopAuthTicketExchangeInProgress()) {
    throw new DesktopAuthFailure('A desktop sign-in is already in progress. Try signing in again.');
  }
  exchangingTickets += 1;
  exchangeListeners.forEach((listener) => listener());
  try {
    const assertCurrent = () => {
      if (options.isCurrent && !options.isCurrent()) throw new DesktopAuthFailure('The desktop sign-in was cancelled. Start sign-in again.');
    };
    assertCurrent();
    const { error } = await options.signIn.ticket({ ticket }).catch(() => {
      throw new DesktopAuthFailure('The sign-in ticket could not be exchanged. Try signing in again.');
    });
    assertCurrent();
    if (error) throw new DesktopAuthFailure('The sign-in ticket could not be exchanged. Try signing in again.');
    if (options.signIn.status !== 'complete') {
      throw new DesktopAuthFailure('The sign-in is incomplete. Try signing in again.');
    }
    const { error: finalizeError } = await options.signIn.finalize().catch(() => {
      throw new DesktopAuthFailure('The sign-in session could not be finalized. Try signing in again.');
    });
    assertCurrent();
    if (finalizeError) throw new DesktopAuthFailure('The sign-in session could not be finalized. Try signing in again.');
    try {
      if (options.signIn.createdSessionId) {
        await options.clerk.setActive({ session: options.signIn.createdSessionId });
      }
      await options.clerk.user?.reload?.();
      assertCurrent();
    } catch (error) {
      if (error instanceof DesktopAuthFailure) throw error;
      throw new DesktopAuthFailure('The signed-in session could not be activated. Try signing in again.');
    }
    await options.onActivated?.();
  } catch (error) {
    if (error instanceof DesktopAuthFailure) throw error;
    throw new DesktopAuthFailure('The sign-in ticket exchange failed. Try signing in again.');
  } finally {
    exchangingTickets -= 1;
    exchangeListeners.forEach((listener) => listener());
  }
}

function regenerateDesktopSignIn(options: ConsumeDesktopAuthCallbackOptions): void {
  try {
    options.retrySignIn?.();
  } catch {
    console.error('[auth] failed to regenerate desktop sign-in');
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
  const generation = handoffGeneration;
  const isCurrent = () => generation === handoffGeneration;
  if (options.validateHandoff) {
    const valid = await options.validateHandoff(state).catch(() => false);
    if (!valid || !isCurrent()) {
      reportDesktopAuthError('This sign-in handoff expired. Start sign-in again.');
      // A stale callback must never automatically begin a new handoff.
      return;
    }
  }
  if (consumedTickets.has(ticket)) {
    reportDesktopAuthError('This sign-in link was already used. Try signing in again.');
    regenerateDesktopSignIn(options);
    return;
  }

  const expected = options.getExpectedState();
  if (!options.validateHandoff && expected && state !== expected) {
    console.warn('[auth] callback state mismatch — ignoring');
    reportDesktopAuthError('The sign-in response did not match this app session. Try signing in again.');
    regenerateDesktopSignIn(options);
    return;
  }

  consumedTickets.add(ticket);
  try {
    await exchangeDesktopAuthTicket(ticket, {
      ...options,
      isCurrent,
      onActivated: async () => {
        options.clearExpectedState();
        clearDesktopAuthError();
        // Retire the marker before the bridge can sync or enroll this session.
        await Promise.resolve(options.onSignInComplete?.()).catch(() => {});
        browserSignInListeners.forEach((listener) => listener());
      },
    });
  } catch (err) {
    const reason = err instanceof DesktopAuthFailure
      ? err.message : 'The sign-in ticket exchange failed. Try signing in again.';
    reportDesktopAuthError(reason);
    if (isCurrent()) regenerateDesktopSignIn(options);
  }
}
