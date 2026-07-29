import { afterEach, describe, expect, it, vi } from 'vitest';

import { writeConnectAttachEnabled } from '@/lib/connect/attach-settings';

import { GET, POST } from './route';

afterEach(() => {
  writeConnectAttachEnabled(false);
  vi.unstubAllEnvs();
});

describe('/api/panel/connect/attach', () => {
  it('reads and writes the local operator opt-in through the real route', async () => {
    vi.stubEnv('O8_CONNECT_ATTACH', '');
    writeConnectAttachEnabled(false);

    const initial = await GET();
    expect(await initial.json()).toMatchObject({ ok: true, enabled: false });

    const updated = await POST(new Request('http://localhost/api/panel/connect/attach', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    }));
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ ok: true, enabled: true });

    const current = await GET();
    expect(await current.json()).toMatchObject({ ok: true, enabled: true });
  });

  it('rejects non-boolean setting values', async () => {
    vi.stubEnv('O8_CONNECT_ATTACH', '');
    const response = await POST(new Request('http://localhost/api/panel/connect/attach', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: 'yes' }),
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
  });
});
