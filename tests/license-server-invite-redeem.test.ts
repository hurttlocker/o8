import { generateKeyPairSync } from 'node:crypto';

import { afterAll, describe, expect, it, vi } from 'vitest';

const serveMock = vi.hoisted(() => vi.fn());
const returningMock = vi.hoisted(() => vi.fn(async () => [{ owner: 'modern-owner' }]));
const updateMock = vi.hoisted(() => vi.fn(() => ({
  set: () => ({
    where: () => ({
      returning: returningMock,
    }),
  }),
})));

vi.mock('@hono/node-server', () => ({
  serve: serveMock,
}));

vi.mock('../services/license-server/src/db/client.js', () => ({
  db: {
    update: updateMock,
  },
}));

vi.mock('../services/license-server/src/db/migrate.js', () => ({
  runStartupMigrations: vi.fn(async () => {}),
}));

const priorEnv = { ...process.env };
const { privateKey } = generateKeyPairSync('ed25519');
Object.assign(process.env, {
  STRIPE_SECRET_KEY: 'sk_test_o8',
  STRIPE_WEBHOOK_SECRET: 'whsec_o8',
  STRIPE_PRICE_SOLO: 'price_solo',
  STRIPE_PRICE_TEAM: 'price_team',
  LICENSE_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  DATABASE_URL: 'postgres://unused:unused@127.0.0.1:1/unused',
  ADMIN_TOKEN: 'test-admin',
});

const { app } = await import('../services/license-server/src/index.js');

afterAll(() => {
  process.env = priorEnv;
});

function redeem(code: string) {
  return app.request('/invites/redeem', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code,
      email: 'invitee@example.com',
    }),
  });
}

describe('license-server invite redemption route', () => {
  it('rejects legacy six-digit invite codes with a clear expiration error', async () => {
    const response = await redeem('123-456');

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      reason: 'legacy invite codes are no longer valid',
    });
  });

  it('keeps 128-bit invite redemption working', async () => {
    const response = await redeem('o8_0123456789abcdefABCDEF');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      owner: 'modern-owner',
    });
  });
});
