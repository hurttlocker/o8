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

  it('reports Clerk ticket exchange longMessage', async () => {
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

    expect(getDesktopAuthError()?.message).toBe('sign in token has already been used');
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

    expect(getDesktopAuthError()?.message).toBe('finalize failed upstream');
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

    expect(getDesktopAuthError()?.message).toBe('ticket exchange raced');
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

    expect(getDesktopAuthError()?.message).toBe('session activation failed');
  });

  it('reports incomplete sign-in status', async () => {
    await consumeDesktopAuthCallback(callbackUrl(), {
      signIn: makeSignIn({ status: 'needs_first_factor' }),
      clerk: makeClerk(),
      getExpectedState: () => 'state_123',
      clearExpectedState: vi.fn(),
    });

    expect(getDesktopAuthError()?.message).toContain('needs_first_factor');
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
});
