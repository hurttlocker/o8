import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MANAGED_GITHUB_REFRESH_INTERVAL_MS,
  scheduleManagedGithubRefresh,
} from '@/lib/github-broker/refresh-schedule';

describe('managed GitHub refresh schedule', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refreshes before the one-hour installation token expires', () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const stop = scheduleManagedGithubRefresh(refresh);

    vi.advanceTimersByTime(MANAGED_GITHUB_REFRESH_INTERVAL_MS - 1);
    expect(refresh).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(1);

    stop();
    vi.advanceTimersByTime(MANAGED_GITHUB_REFRESH_INTERVAL_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
