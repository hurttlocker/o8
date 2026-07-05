import { afterEach, describe, expect, it, vi } from 'vitest';

const existsSyncMock = vi.hoisted(() => vi.fn());
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  existsSync: existsSyncMock,
}));

import { exitWhenBundleDeleted } from './orphan-exit';

afterEach(() => {
  // Clear the armed interval while timers are still faked — a survivor firing
  // mid-suite with the mock reset failed CI (logged during vitest teardown).
  vi.clearAllTimers();
  vi.useRealTimers();
  existsSyncMock.mockReset();
  vi.restoreAllMocks();
});

describe('exitWhenBundleDeleted (#1333)', () => {
  it('exits clean when the bundle path disappears (app uninstalled)', () => {
    vi.useFakeTimers();
    existsSyncMock.mockReturnValue(true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    exitWhenBundleDeleted('test');
    vi.advanceTimersByTime(50_000);
    expect(exitSpy).not.toHaveBeenCalled();

    existsSyncMock.mockReturnValue(false);
    vi.advanceTimersByTime(50_000);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('never arms without a baseline path', () => {
    vi.useFakeTimers();
    existsSyncMock.mockReturnValue(false);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    exitWhenBundleDeleted('test');
    vi.advanceTimersByTime(120_000);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
