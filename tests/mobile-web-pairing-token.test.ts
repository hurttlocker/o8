import { afterEach, describe, expect, it, vi } from 'vitest';
import { getMobileWsToken } from '@/lib/mobile/ws-token-client';

describe('mobile web pairing token fragment', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('captures #tk while preserving E2EE enrollment fields in the URL', () => {
    const replaceState = vi.fn();
    const setItem = vi.fn();

    vi.stubGlobal('window', {
      location: {
        hash: '#tk=operator-token&v=1&enroll=enrollment-token&sIdent=server-identity',
        pathname: '/mobile',
        search: '',
      },
      history: {
        state: null,
        replaceState,
      },
      localStorage: {
        getItem: vi.fn(() => null),
        setItem,
      },
    });
    vi.stubGlobal('document', {
      querySelector: vi.fn(() => null),
    });

    expect(getMobileWsToken()).toBe('operator-token');
    expect(setItem).toHaveBeenCalledWith('o8:mobile-ws-token', 'operator-token');
    expect(replaceState).toHaveBeenCalledWith(
      null,
      '',
      '/mobile#v=1&enroll=enrollment-token&sIdent=server-identity',
    );
  });
});
