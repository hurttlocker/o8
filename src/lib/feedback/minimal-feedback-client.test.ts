import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sharing = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/lib/feedback/report-data-sharing-client', () => ({ readReportDataSharingEnabled: sharing }));

import { submitFeedback } from './minimal-feedback-client';

beforeEach(() => { sharing.mockReset(); sharing.mockResolvedValue(true); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('submitFeedback', () => {
  it('allowlists the request fields and defaults version/OS selection on', async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true, reportId: 'ABC234' }));
    vi.stubGlobal('fetch', fetchMock);
    const input = { message: 'Setup was confusing.', email: ' reader@example.test ', route: 'private-route', prompt: 'private-prompt' };
    await expect(submitFeedback(input)).resolves.toEqual({ ok: true, reportId: 'ABC234' });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/feedback/report');
    expect(JSON.parse(String(init.body))).toEqual({
      kind: 'feedback', message: 'Setup was confusing.', email: 'reader@example.test', includeMetadata: true,
    });
  });

  it('honors metadata opt-out and omits empty email', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(JSON.parse(String(init.body))).toEqual({ kind: 'feedback', message: 'A suggestion.', includeMetadata: false });
      return Response.json({ ok: true, reportId: 'ABC234' });
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(submitFeedback({ message: 'A suggestion.', email: ' ', includeMetadata: false })).resolves.toMatchObject({ ok: true });
  });

  it.each(['disabled', 'unreadable'])('does not send when data sharing is %s', async (state) => {
    if (state === 'disabled') sharing.mockResolvedValue(false);
    else sharing.mockRejectedValue(new Error('unreadable'));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(submitFeedback({ message: 'Keep local.' })).resolves.toMatchObject({ ok: false, code: 'data_sharing_off' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['invalid-receipt', 'server-error', 'network-error'])('returns a recoverable failure for %s', async (failure) => {
    vi.stubGlobal('fetch', async () => {
      if (failure === 'network-error') throw new Error('offline');
      if (failure === 'server-error') return Response.json({ ok: false, error: 'relay unavailable' }, { status: 502 });
      return Response.json({ ok: true });
    });
    await expect(submitFeedback({ message: 'A suggestion.' })).resolves.toMatchObject({ ok: false, error: expect.any(String) });
  });
});
