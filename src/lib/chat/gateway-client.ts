import 'server-only';

import { createGateway, type GatewayProviderOptions } from '@ai-sdk/gateway';
import { streamText, type ModelMessage } from 'ai';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ChatHistoryMessage } from '@/lib/chat/types';
import { MODEL_IDS } from '@/lib/models';
import { getDataDir } from '@/lib/data-dir-migration';

export const FREE_CHAT_MODEL_ID = 'deepseek/deepseek-v3.2';
export const PAID_CHAT_MODEL_ID = `anthropic/${MODEL_IDS.claudeQaDefault}`;
export const CHAT_GATEWAY_PROVIDER = 'deepseek';

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

function buildHeliconeHeaders(userId: string, credentialType: 'system' | 'byok') {
  const heliconeApiKey = requiredEnv('HELICONE_API_KEY') ?? '';
  const dateUtc = new Date().toISOString().slice(0, 10);
  return {
    'Helicone-Auth': `Bearer ${heliconeApiKey}`,
    'Helicone-User-Id': userId,
    'Helicone-Property-App': 'o8-orchestrator-chat',
    'Helicone-Property-Model': FREE_CHAT_MODEL_ID,
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

export function streamGatewayChat(input: StreamGatewayChatInput): AsyncIterable<string> {
  const gatewayApiKey = requiredEnv('VERCEL_AI_GATEWAY_API_KEY') ?? '';
  const credentialType = input.byokApiKey ? 'byok' : 'system';
  const heliconeHeaders = buildHeliconeHeaders(input.userId, credentialType);
  const gateway = createGateway({
    apiKey: gatewayApiKey,
    headers: heliconeHeaders,
  });
  const providerOptions = input.byokApiKey
    ? {
        gateway: {
          byok: {
            [CHAT_GATEWAY_PROVIDER]: [{ apiKey: input.byokApiKey }],
          },
        },
      } satisfies { gateway: GatewayProviderOptions }
    : undefined;

  const result = streamText({
    model: gateway(FREE_CHAT_MODEL_ID),
    messages: toModelMessages(input.history, input.message),
    headers: heliconeHeaders,
    providerOptions,
    abortSignal: input.abortSignal,
  });

  return result.textStream;
}
