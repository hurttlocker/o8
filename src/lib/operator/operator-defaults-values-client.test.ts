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

  it('keeps the replacement read shared when an obsolete read finishes first', async () => {
    invalidateOperatorDefaultsValuesSnapshot();
    let releaseOld!: (response: Response) => void;
    let releaseCurrent!: (response: Response) => void;
    const oldGate = new Promise<Response>((resolve) => { releaseOld = resolve; });
    const currentGate = new Promise<Response>((resolve) => { releaseCurrent = resolve; });
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => oldGate)
      .mockImplementationOnce(() => currentGate);
    vi.stubGlobal('fetch', fetchMock);

    const oldRead = fetchOperatorDefaultsValues();
    invalidateOperatorDefaultsValuesSnapshot();
    const currentRead = fetchOperatorDefaultsValues();
    releaseOld(Response.json({ values: { parallelCap: 1 } }));
    // A caller that started before invalidation may still consume its reply.
    await expect((await oldRead).json()).resolves.toMatchObject({ values: { parallelCap: 1 } });
    const joinedRead = fetchOperatorDefaultsValues();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    releaseCurrent(Response.json({ values: { parallelCap: 4 } }));
    for (const response of await Promise.all([currentRead, joinedRead, fetchOperatorDefaultsValues()])) {
      await expect(response.json()).resolves.toMatchObject({ values: { parallelCap: 4 } });
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
