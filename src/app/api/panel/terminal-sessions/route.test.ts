import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';

vi.mock('@/lib/ws-auth', () => ({ getOrCreateWsToken: () => 'terminal-status-fixture' }));
vi.mock('@/lib/panel/api-port', () => ({ resolvePortInfo: () => ({ wsPort: 12345 }) }));
afterEach(() => vi.unstubAllGlobals());

describe('terminal status evidence', () => {
  it.each(['transport', 'http', 'malformed'])('reports unavailable rather than no sessions after %s failure', async (failure) => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (failure === 'transport') throw new Error('offline');
      return new Response(JSON.stringify(failure === 'malformed' ? {} : { sessions: [] }), { status: failure === 'http' ? 503 : 200 });
    }));
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Terminal status is unavailable.' });
  });

  it('distinguishes an observed empty inventory from unavailable evidence', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ sessions: [] }))));
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sessions: [] });
  });
});
