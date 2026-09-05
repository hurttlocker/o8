import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fetchThoughtsOperatorDefaults,
  normalizeThoughtsOperatorDefaults,
  scheduleThoughtsRuntimeReadiness,
  THOUGHTS_OPERATOR_DEFAULTS_FALLBACK,
  THOUGHTS_RUNTIME_READINESS_DELAY_MS,
} from './operator-defaults';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('thoughts operator defaults', () => {
  it('derives ready runtime count from the existing defaults response', () => {
    const defaults = normalizeThoughtsOperatorDefaults({
      dispatchableRuntimes: [
        { available: true },
        { available: false },
        { available: true },
      ],
    });

    expect(defaults.readyRuntimeCount).toBe(2);
  });

  it('keeps readiness unknown when the server omits its inventory', () => {
    expect(normalizeThoughtsOperatorDefaults(null).readyRuntimeCount)
      .toBe(THOUGHTS_OPERATOR_DEFAULTS_FALLBACK.readyRuntimeCount);
  });

  it('loads launch preferences through the value-only route', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      values: { orchestratorModel: 'test-model' },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const defaults = await fetchThoughtsOperatorDefaults();

    expect(defaults.orchestratorModel).toBe('test-model');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/panel/operator-defaults?include=values',
      expect.objectContaining({ cache: 'no-store' }),
    );
  });

  it('defers the full readiness probe until after first paint', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      dispatchableRuntimes: [{ available: true }, { available: false }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const onReady = vi.fn();
    const cancel = scheduleThoughtsRuntimeReadiness(new AbortController().signal, onReady);

    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(THOUGHTS_RUNTIME_READINESS_DELAY_MS);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenCalledWith(1);
    cancel();
  });
});
