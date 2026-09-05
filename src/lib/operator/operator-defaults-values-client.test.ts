import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fetchOperatorDefaultsValues,
  invalidateOperatorDefaultsValuesSnapshot,
} from './operator-defaults-values-client';

afterEach(() => {
  invalidateOperatorDefaultsValuesSnapshot();
  vi.unstubAllGlobals();
});

describe('operator defaults value client', () => {
  it('coalesces concurrent launch reads into one request', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ values: { parallelCap: 4 } })));
    vi.stubGlobal('fetch', fetchMock);

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => fetchOperatorDefaultsValues()),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/panel/operator-defaults?include=values',
      { cache: 'no-store' },
    );
    await expect(responses[0].json()).resolves.toMatchObject({ values: { parallelCap: 4 } });
  });
});
