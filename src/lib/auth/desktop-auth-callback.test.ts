import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  consumeDesktopAuthCallback,
  resetConsumedDesktopAuthTicketsForTest,
  type DesktopAuthClerk,
  type DesktopAuthSignIn,
} from '@/lib/auth/desktop-auth-callback';
import { clearDesktopAuthError, getDesktopAuthError, reportDesktopAuthError } from '@/lib/auth/desktop-auth-error';

function makeSignIn(overrides: Partial<DesktopAuthSignIn> = {}): DesktopAuthSignIn {
  return {
    status: 'complete',
    createdSessionId: 'sess_123',
    ticket: vi.fn(async () => ({})),
    finalize: vi.fn(async () => ({})),
    ...overrides,
  };
}

function makeClerk(overrides: Partial<DesktopAuthClerk> = {}): DesktopAuthClerk {
  return {
    setActive: vi.fn(async () => undefined),
    user: { reload: vi.fn(async () => undefined) },
    ...overrides,
  };
}

function callbackUrl(ticket = 'ticket_123', state = 'state_123'): string {
  return `o8://auth/callback?ticket=${ticket}&state=${state}`;
}

describe('consumeDesktopAuthCallback', () => {
  beforeEach(() => {
    resetConsumedDesktopAuthTicketsForTest();
    clearDesktopAuthError();
    vi.restoreAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('reports state mismatch without burning the ticket', async () => {
    const signIn = makeSignIn();
    const retrySignIn = vi.fn();
    await consumeDesktopAuthCallback(callbackUrl(), {
      signIn,
      clerk: makeClerk(),
      getExpectedState: () => 'different',
      clearExpectedState: vi.fn(),
      retrySignIn,
    });

    expect(signIn.ticket).not.toHaveBeenCalled();
    expect(getDesktopAuthError()?.message).toContain('did not match');
    expect(retrySignIn).toHaveBeenCalledOnce();
  });

  it('replaces Clerk ticket exchange details with a fixed message', async () => {
    const retrySignIn = vi.fn();
    const signIn = makeSignIn({
      ticket: vi.fn(async () => ({ error: { longMessage: 'sign in token has already been used' } })),
    });
    await consumeDesktopAuthCallback(callbackUrl(), {
      signIn,
      clerk: makeClerk(),
      getExpectedState: () => 'state_123',
      clearExpectedState: vi.fn(),
      retrySignIn,
    });

    expect(getDesktopAuthError()?.message).toBe('The sign-in ticket could not be exchanged. Try signing in again.');
    expect(retrySignIn).toHaveBeenCalledOnce();
  });

  it('reports finalize failures', async () => {
    const retrySignIn = vi.fn();
    const signIn = makeSignIn({
      finalize: vi.fn(async () => ({ error: { longMessage: 'finalize failed upstream' } })),
    });
    await consumeDesktopAuthCallback(callbackUrl(), {
      signIn,
      clerk: makeClerk(),
      getExpectedState: () => 'state_123',
      clearExpectedState: vi.fn(),
      retrySignIn,
    });

    expect(getDesktopAuthError()?.message).toBe('The sign-in session could not be finalized. Try signing in again.');
    expect(retrySignIn).toHaveBeenCalledOnce();
  });

  it('regenerates sign-in when a ticket exchange throws after consuming the ticket', async () => {
    const retrySignIn = vi.fn();
    await consumeDesktopAuthCallback(callbackUrl('ticket_raced'), {
      signIn: makeSignIn({
        ticket: vi.fn(async () => {
          throw new Error('ticket exchange raced');
        }),
      }),
      clerk: makeClerk(),
      getExpectedState: () => 'state_123',
      clearExpectedState: vi.fn(),
      retrySignIn,
    });

    expect(getDesktopAuthError()?.message).toBe('The sign-in ticket could not be exchanged. Try signing in again.');
    expect(retrySignIn).toHaveBeenCalledOnce();
  });

  it('reports setActive failures', async () => {
    const clerk = makeClerk({
      setActive: vi.fn(async () => {
        throw new Error('session activation failed');
      }),
    });
    await consumeDesktopAuthCallback(callbackUrl(), {
      signIn: makeSignIn(),
      clerk,
      getExpectedState: () => 'state_123',
      clearExpectedState: vi.fn(),
    });

    expect(getDesktopAuthError()?.message).toBe('The signed-in session could not be activated. Try signing in again.');
  });

  it('reports incomplete sign-in status', async () => {
    await consumeDesktopAuthCallback(callbackUrl(), {
      signIn: makeSignIn({ status: 'needs_first_factor' }),
      clerk: makeClerk(),
      getExpectedState: () => 'state_123',
      clearExpectedState: vi.fn(),
    });

    expect(getDesktopAuthError()?.message).toBe('The sign-in is incomplete. Try signing in again.');
  });

  it('clears stale errors after a successful activation', async () => {
    const clearExpectedState = vi.fn();
    reportDesktopAuthError('old failure');
    await consumeDesktopAuthCallback(callbackUrl(), {
      signIn: makeSignIn(),
      clerk: makeClerk(),
      getExpectedState: () => 'state_123',
      clearExpectedState,
    });

    expect(clearExpectedState).toHaveBeenCalledOnce();
    expect(getDesktopAuthError()).toBeNull();
  });

  it('surfaces a used-link reason for duplicate tickets', async () => {
    const signIn = makeSignIn();
    const retrySignIn = vi.fn();
    const options = {
      signIn,
      clerk: makeClerk(),
      getExpectedState: () => 'state_123',
      clearExpectedState: vi.fn(),
      retrySignIn,
    };
    await consumeDesktopAuthCallback(callbackUrl('ticket_once'), options);
    await consumeDesktopAuthCallback(callbackUrl('ticket_once'), options);

    expect(signIn.ticket).toHaveBeenCalledOnce();
    expect(getDesktopAuthError()?.message).toContain('already used');
    expect(retrySignIn).toHaveBeenCalledOnce();
  });
  it.each(['ticket-return', 'ticket-throw', 'finalize', 'activate', 'status', 'retry']) (
    'never exposes upstream secrets for %s', async (stage) => {
      const secret = 'SYNTHETIC_CALLBACK_SECRET_NOT_VALID';
      const failure = Object.assign(new Error(secret), {
        stack: secret, cause: { authorization: secret }, response: { ticket: secret }, longMessage: secret,
      });
      const signIn = makeSignIn();
      const clerk = makeClerk();
      const retrySignIn = vi.fn(() => { if (stage === 'retry') throw failure; });
      if (stage === 'ticket-return' || stage === 'retry') signIn.ticket = vi.fn(async () => ({ error: failure }));
      if (stage === 'ticket-throw') signIn.ticket = vi.fn(async () => { throw failure; });
      if (stage === 'finalize') signIn.finalize = vi.fn(async () => { throw failure; });
      if (stage === 'activate') clerk.setActive = vi.fn(async () => { throw failure; });
      if (stage === 'status') signIn.status = secret;
      await consumeDesktopAuthCallback(callbackUrl(secret), {
        signIn, clerk, retrySignIn, getExpectedState: () => 'state_123', clearExpectedState: vi.fn(),
      });
      expect(getDesktopAuthError()).not.toBeNull();
      expect(JSON.stringify(getDesktopAuthError())).not.toContain(secret);
      expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(secret);
      expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(secret);
    },
  );

});
