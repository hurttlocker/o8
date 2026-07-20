import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/feedback/report-data-sharing-client', () => ({
  readReportDataSharingEnabled: vi.fn(async () => true),
}));

const { submitReport } = await import('./report-client');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('report screenshot upload consent', () => {
  it('omits the image payload when the report surface excludes its screenshot', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('/api/feedback/report');
      expect(init?.method).toBe('POST');
      return new Response(
        JSON.stringify({ ok: true, reportId: 'R-EXCLUDED' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await submitReport({
      category: 'bug',
      message: 'The screenshot was excluded.',
      route: '/dashboard',
      image: null,
      includeDiagnostics: false,
    });

    const request = fetchMock.mock.calls[0]?.[1];
    const body = JSON.parse(String(request?.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty('image');
  });

  it('includes the image payload when screenshot consent remains enabled', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('/api/feedback/report');
      expect(init?.method).toBe('POST');
      return new Response(
        JSON.stringify({ ok: true, reportId: 'R-INCLUDED' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await submitReport({
      category: 'bug',
      message: 'The screenshot was reviewed.',
      route: '/dashboard',
      image: { dataUrl: 'data:image/png;base64,c2FmZQ==', name: 'reviewed.png' },
      includeDiagnostics: false,
    });

    const request = fetchMock.mock.calls[0]?.[1];
    const body = JSON.parse(String(request?.body)) as Record<string, unknown>;
    expect(body.image).toEqual({ dataUrl: 'data:image/png;base64,c2FmZQ==', name: 'reviewed.png' });
  });
});
