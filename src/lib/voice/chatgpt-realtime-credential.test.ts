import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveChatGPTRealtimeCredential } from './chatgpt-realtime-credential';

const tempDirs: string[] = [];

function jwt(exp: number): string {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode({ exp })}.${'x'.repeat(40)}`;
}

async function authFile(value: unknown): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'o8-chatgpt-auth-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'auth.json');
  await writeFile(file, JSON.stringify(value), 'utf8');
  return file;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('resolveChatGPTRealtimeCredential', () => {
  it('returns a live ChatGPT OAuth access token without exposing other auth fields', async () => {
    const nowMs = 1_800_000_000_000;
    const accessToken = jwt(Math.floor(nowMs / 1_000) + 600);
    const file = await authFile({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: 'sk-must-not-win',
      tokens: {
        access_token: accessToken,
        refresh_token: 'refresh-must-not-return',
        account_id: 'acct-founder',
      },
    });

    await expect(
      resolveChatGPTRealtimeCredential({ authPath: file, nowMs }),
    ).resolves.toEqual({
      accessToken,
      accountId: 'acct-founder',
      expiresAt: (Math.floor(nowMs / 1_000) + 600) * 1_000,
    });
  });

  it('rejects API-key mode even when an OAuth-shaped token is present', async () => {
    const file = await authFile({
      auth_mode: 'apikey',
      tokens: { access_token: 'x'.repeat(64) },
    });

    await expect(
      resolveChatGPTRealtimeCredential({ authPath: file }),
    ).resolves.toBeNull();
  });

  it('rejects an expired OAuth token and malformed auth files', async () => {
    const nowMs = 1_800_000_000_000;
    const expired = await authFile({
      auth_mode: 'chatgpt',
      tokens: { access_token: jwt(Math.floor(nowMs / 1_000) - 1) },
    });
    const malformed = await authFile('{');

    await expect(
      resolveChatGPTRealtimeCredential({ authPath: expired, nowMs }),
    ).resolves.toBeNull();
    await expect(
      resolveChatGPTRealtimeCredential({ authPath: malformed, nowMs }),
    ).resolves.toBeNull();
  });
});
