import 'server-only';

import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MIN_TOKEN_LENGTH = 32;
const MAX_TOKEN_LENGTH = 32 * 1024;
const EXPIRY_SKEW_SECONDS = 30;

type CodexAuthFile = {
  auth_mode?: unknown;
  tokens?: {
    access_token?: unknown;
    account_id?: unknown;
  };
};

export interface ChatGPTRealtimeCredential {
  accessToken: string;
  accountId: string | null;
  expiresAt: number | null;
}

export interface ChatGPTRealtimeCredentialOptions {
  authPath?: string;
  nowMs?: number;
}

function jwtExpiresAt(token: string): number | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as { exp?: unknown };
    return typeof parsed.exp === 'number' && Number.isFinite(parsed.exp)
      ? parsed.exp * 1000
      : null;
  } catch {
    return null;
  }
}

/**
 * Read the standard Codex ChatGPT-OAuth credential for Realtime minting.
 *
 * The access token never leaves this server-only module except as an in-memory
 * bearer used by the OpenAI client-secrets request. API-key auth is
 * deliberately ignored so callers can distinguish subscription voice from
 * metered Platform spend.
 */
export async function resolveChatGPTRealtimeCredential(
  options: ChatGPTRealtimeCredentialOptions = {},
): Promise<ChatGPTRealtimeCredential | null> {
  const codexHome =
    process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');
  const authPath = options.authPath ?? path.join(codexHome, 'auth.json');
  let auth: CodexAuthFile;
  try {
    auth = JSON.parse(await readFile(authPath, 'utf8')) as CodexAuthFile;
  } catch {
    return null;
  }

  if (
    typeof auth.auth_mode !== 'string' ||
    auth.auth_mode.trim().toLowerCase() !== 'chatgpt'
  ) {
    return null;
  }

  const accessToken =
    typeof auth.tokens?.access_token === 'string'
      ? auth.tokens.access_token.trim()
      : '';
  if (
    accessToken.length < MIN_TOKEN_LENGTH ||
    accessToken.length > MAX_TOKEN_LENGTH
  ) {
    return null;
  }

  const expiresAt = jwtExpiresAt(accessToken);
  const nowMs = options.nowMs ?? Date.now();
  if (
    expiresAt !== null &&
    expiresAt <= nowMs + EXPIRY_SKEW_SECONDS * 1_000
  ) {
    return null;
  }

  const accountId =
    typeof auth.tokens?.account_id === 'string' &&
    auth.tokens.account_id.trim()
      ? auth.tokens.account_id.trim()
      : null;
  return { accessToken, accountId, expiresAt };
}
