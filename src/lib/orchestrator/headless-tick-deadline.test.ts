import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  applyHeadlessTickDeadline,
  HEADLESS_LAUNCH_DEADLINE_MS,
  HEADLESS_TICK_DEADLINE_MS,
} from '@/lib/orchestrator/headless-tick-deadline';

afterEach(() => {
  vi.useRealTimers();
});

describe('headless tick deadline', () => {
  it('retains the short deadline when no launch started', async () => {
    vi.useFakeTimers();
    const pending = new Promise<never>(() => undefined);
    const bounded = applyHeadlessTickDeadline(pending, {
      canExtendForLaunch: () => false,
    });
    const assertion = expect(bounded).rejects.toThrow(
      `Headless tick exceeded ${HEADLESS_TICK_DEADLINE_MS}ms deadline`,
    );

    await vi.advanceTimersByTimeAsync(HEADLESS_TICK_DEADLINE_MS);
    await assertion;
  });

  it('allows a fresh cold launch to finish after the ordinary tick deadline', async () => {
    vi.useFakeTimers();
    let resolveLaunch!: (value: string) => void;
    const launch = new Promise<string>((resolve) => {
      resolveLaunch = resolve;
    });
    const onExtended = vi.fn();
    const bounded = applyHeadlessTickDeadline(launch, {
      canExtendForLaunch: () => true,
      onExtended,
    });

    await vi.advanceTimersByTimeAsync(HEADLESS_TICK_DEADLINE_MS);
    expect(onExtended).toHaveBeenCalledWith(HEADLESS_LAUNCH_DEADLINE_MS);
    resolveLaunch('launched');
    await expect(bounded).resolves.toBe('launched');
  });

  it('still bounds a launch that never finishes', async () => {
    vi.useFakeTimers();
    const pending = new Promise<never>(() => undefined);
    const bounded = applyHeadlessTickDeadline(pending, {
      canExtendForLaunch: () => true,
    });
    const assertion = expect(bounded).rejects.toThrow(
      `Headless launch tick exceeded ${HEADLESS_LAUNCH_DEADLINE_MS}ms deadline`,
    );

    await vi.advanceTimersByTimeAsync(HEADLESS_LAUNCH_DEADLINE_MS);
    await assertion;
  });
});
