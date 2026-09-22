import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ resolve: vi.fn(), exec: vi.fn() }));
vi.mock('./cli-resolver', () => ({ resolveCli: h.resolve }));
vi.mock('node:util', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:util')>(), promisify: () => h.exec,
}));
import { probeAntigravityLogin } from './antigravity-login-probe';

beforeEach(() => {
  h.resolve.mockReset().mockResolvedValue({ path: '/fixture/agy' });
  h.exec.mockReset().mockResolvedValue({ stdout: 'gemini-3.8-flash-low Gemini 3.8 Flash (Low)\n' });
});
afterEach(() => vi.useRealTimers());

describe('headless worker login readiness', () => {
  it('uses the dispatch resolver and requires a returned model catalogue', async () => {
    await expect(probeAntigravityLogin()).resolves.toMatchObject({ installed: true, authenticated: true });
    expect(h.resolve).toHaveBeenCalledWith({ runtimeId: 'antigravity', binaryName: 'agy', envOverride: 'O8_ANTIGRAVITY_BIN' });
    expect(h.exec).toHaveBeenCalledWith('/fixture/agy', ['models'], expect.objectContaining({ timeout: expect.any(Number) }));
  });
  it.each(['Please sign in: private-account-marker', 'Fetching models...', ''])('does not treat non-model output as authentication', async (stdout) => {
    h.exec.mockResolvedValue({ stdout });
    const result = await probeAntigravityLogin();
    expect(result).toMatchObject({ installed: true, authenticated: false });
    expect(JSON.stringify(result)).not.toContain('private-account-marker');
  });
  it('keeps a failed sign-in probe installed but unavailable', async () => {
    h.exec.mockRejectedValue(new Error('private-provider-error'));
    await expect(probeAntigravityLogin()).resolves.toMatchObject({ installed: true, authenticated: false });
  });
  it('does not probe after the setup deadline', async () => {
    await expect(probeAntigravityLogin(Date.now() - 1)).resolves.toMatchObject({ authenticated: false });
    expect(h.resolve).not.toHaveBeenCalled();
    expect(h.exec).not.toHaveBeenCalled();
  });
  it('bounds a stalled binary lookup and never launches the model probe afterward', async () => {
    vi.useFakeTimers();
    let resolve!: (value: { path: string }) => void;
    h.resolve.mockImplementation(() => new Promise(r => { resolve = r; }));
    const result = probeAntigravityLogin(Date.now() + 100);
    await vi.advanceTimersByTimeAsync(100);
    await expect(result).resolves.toMatchObject({ authenticated: false });
    resolve({ path: '/fixture/agy' });
    await vi.advanceTimersByTimeAsync(1);
    expect(h.exec).not.toHaveBeenCalled();
  });
});
