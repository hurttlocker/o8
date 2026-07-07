import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
const clearMock = vi.fn();
const saveMock = vi.fn();
const closeMock = vi.fn();
const loadMock = vi.fn(async () => ({
  clear: clearMock,
  save: saveMock,
  close: closeMock,
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('@tauri-apps/plugin-store', () => ({
  Store: {
    load: loadMock,
  },
}));

describe('tauri Clerk store purge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('marks stale entitlement identities for Clerk store purge', async () => {
    const { shouldPurgeClerkStoreForEntitlementSync } = await import('./tauri-clerk-store');

    expect(shouldPurgeClerkStoreForEntitlementSync('license_subject_mismatch')).toBe(true);
    expect(shouldPurgeClerkStoreForEntitlementSync('stale_session')).toBe(true);
    expect(shouldPurgeClerkStoreForEntitlementSync('signed_out')).toBe(false);
    expect(shouldPurgeClerkStoreForEntitlementSync(undefined)).toBe(false);
  });

  it('clears and saves the native clerk-store in Tauri', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    const { purgeTauriClerkStore } = await import('./tauri-clerk-store');

    await purgeTauriClerkStore();

    expect(invokeMock).toHaveBeenCalledWith('plugin:clerk|set_client_authorization_header', { header: null });
    expect(loadMock).toHaveBeenCalledWith('clerk-store');
    expect(clearMock).toHaveBeenCalledOnce();
    expect(saveMock).toHaveBeenCalledOnce();
    expect(closeMock).toHaveBeenCalledOnce();
  });

  it('does nothing outside Tauri', async () => {
    const { purgeTauriClerkStore } = await import('./tauri-clerk-store');

    await purgeTauriClerkStore();

    expect(invokeMock).not.toHaveBeenCalled();
    expect(loadMock).not.toHaveBeenCalled();
  });
});
