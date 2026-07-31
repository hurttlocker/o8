import 'server-only';

import { createGateway, type GatewayProviderOptions } from '@ai-sdk/gateway';
import { streamText, type ModelMessage } from 'ai';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ChatHistoryMessage } from '@/lib/chat/types';
import { MODEL_IDS } from '@/lib/models';
import { getDataDir } from '@/lib/data-dir-migration';

// The o8-default chat model (Q ruling 2026-07-31): DeepSeek V4-Flash on the
// Gateway — cheaper than the v3.2 it replaced ($0.09/$0.18 vs $0.21/$0.32)
// and a reasoning-class jump. It thinks by default; the bench-proven failure
// mode is token starvation (reasoning eats the budget → empty 200s), so the
// output budget below is generous and an empty/failed stream falls back to
// v3.2 automatically. BYOK stays on v3.2 — that path rides the user's own
// DeepSeek key, and v4-flash's Gateway serving may not route through the
// deepseek provider slug their key is registered under.
export const FREE_CHAT_MODEL_ID = 'deepseek/deepseek-v4-flash';
export const FALLBACK_CHAT_MODEL_ID = 'deepseek/deepseek-v3.2';
export const BYOK_CHAT_MODEL_ID = 'deepseek/deepseek-v3.2';
export const PAID_CHAT_MODEL_ID = `anthropic/${MODEL_IDS.claudeQaDefault}`;
export const CHAT_GATEWAY_PROVIDER = 'deepseek';
// Thinking headroom: bench 07-31 measured up to ~5.5k reasoning tokens on a
// hard prompt at low effort — a small cap reproduces the empty-response bug.
const CHAT_MAX_OUTPUT_TOKENS = 8192;

const ENC_PREFIX = 'enc:' as const;
const DATA_DIR = getDataDir();
const ENV_FILES = [
  path.join(process.cwd(), '.env.local'),
  path.join(DATA_DIR, '.env.local'),
];

interface StreamGatewayChatInput {
  userId: string;
  history: ChatHistoryMessage[];
  message: string;
  byokApiKey?: string;
  abortSignal?: AbortSignal;
}

function requiredEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value || null;
}

export function missingChatGatewayEnv(): string[] {
  const missing = [
    'VERCEL_AI_GATEWAY_API_KEY',
    'HELICONE_API_KEY',
    'CLERK_SECRET_KEY',
  ].filter((name) => !requiredEnv(name));
  if (!requiredEnv('CLERK_PUBLISHABLE_KEY') && !requiredEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY')) {
    missing.push('CLERK_PUBLISHABLE_KEY');
  }
  return missing;
}

function parseRawEnvFile(filePath: string): Map<string, string> {
  const vars = new Map<string, string>();
  if (!existsSync(filePath)) return vars;

  try {
    const content = readFileSync(filePath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();
      if (!value.startsWith(ENC_PREFIX)) {
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
      }
      vars.set(key, value);
    }
  } catch {
    return vars;
  }

  return vars;
}

async function decodeStoredValue(stored: string): Promise<string | null> {
  if (!stored.startsWith(ENC_PREFIX)) return stored;

  const rest = stored.slice(ENC_PREFIX.length);
  const colonIndex = rest.indexOf(':');
  if (colonIndex === -1) return null;

  const iv = rest.slice(0, colonIndex);
  const ciphertext = rest.slice(colonIndex + 1);
  const { decryptValue } = await import('@/lib/db/master-key');
  return decryptValue(ciphertext, iv);
}

export async function resolveDeepSeekByokKey(): Promise<string | null> {
  const envKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (envKey) return envKey;

  for (const envFile of ENV_FILES) {
    const raw = parseRawEnvFile(envFile).get('DEEPSEEK_API_KEY');
    if (!raw) continue;
    const plain = await decodeStoredValue(raw);
    if (plain?.trim()) {
      process.env.DEEPSEEK_API_KEY = plain.trim();
      return plain.trim();
    }
  }

  return null;
}

function buildHeliconeHeaders(userId: string, credentialType: 'system' | 'byok', modelId: string) {
  const heliconeApiKey = requiredEnv('HELICONE_API_KEY') ?? '';
  const dateUtc = new Date().toISOString().slice(0, 10);
  return {
    'Helicone-Auth': `Bearer ${heliconeApiKey}`,
    'Helicone-User-Id': userId,
    'Helicone-Property-App': 'o8-orchestrator-chat',
    'Helicone-Property-Model': modelId,
    'Helicone-Property-Credential': credentialType,
    'Helicone-Property-Date-UTC': dateUtc,
  };
}

function toModelMessages(history: ChatHistoryMessage[], message: string): ModelMessage[] {
  return [
    {
      role: 'system',
      content: 'You are o8 chat mode. Give concise, useful answers. Do not claim to dispatch agents or run tools.',
    },
    ...history
      .filter((item) => item.content.trim().length > 0)
      .map((item) => ({
        role: item.role,
        content: item.content,
      })),
    {
      role: 'user',
      content: message,
    },
  ] satisfies ModelMessage[];
}

export async function* streamGatewayChat(input: StreamGatewayChatInput): AsyncIterable<string> {
  const gatewayApiKey = requiredEnv('VERCEL_AI_GATEWAY_API_KEY') ?? '';
  const credentialType = input.byokApiKey ? 'byok' : 'system';
  const primaryModelId = input.byokApiKey ? BYOK_CHAT_MODEL_ID : FREE_CHAT_MODEL_ID;
  const messages = toModelMessages(input.history, input.message);
  const providerOptions = input.byokApiKey
    ? {
        gateway: {
          byok: {
            [CHAT_GATEWAY_PROVIDER]: [{ apiKey: input.byokApiKey }],
          },
        },
      } satisfies { gateway: GatewayProviderOptions }
    : undefined;

  const stream = (modelId: string) => {
    const heliconeHeaders = buildHeliconeHeaders(input.userId, credentialType, modelId);
    const gateway = createGateway({
      apiKey: gatewayApiKey,
      headers: heliconeHeaders,
    });
    return streamText({
      model: gateway(modelId),
      messages,
      maxOutputTokens: CHAT_MAX_OUTPUT_TOKENS,
      headers: heliconeHeaders,
      providerOptions,
      abortSignal: input.abortSignal,
    }).textStream;
  };

  // Primary model, with the v3.2 fallback armed until the first real token.
  // A reasoning model can fail SILENTLY — stream ends, zero content (bench
  // 07-31) — so "no text arrived" counts as failure, not just a throw. Once
  // any token reached the user we can't cleanly restart; errors then surface.
  let streamedAny = false;
  try {
    for await (const text of stream(primaryModelId)) {
      if (text) streamedAny = true;
      yield text;
    }
    if (streamedAny) return;
  } catch (error) {
    if (streamedAny || input.abortSignal?.aborted) throw error;
    console.warn(`[chat-gateway] ${primaryModelId} failed before first token, falling back to ${FALLBACK_CHAT_MODEL_ID}:`, error instanceof Error ? error.message : error);
  }
  if (primaryModelId === FALLBACK_CHAT_MODEL_ID) return;

  for await (const text of stream(FALLBACK_CHAT_MODEL_ID)) {
    yield text;
  }
}
