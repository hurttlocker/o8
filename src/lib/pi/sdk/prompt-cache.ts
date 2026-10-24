import { createHash } from 'node:crypto';
import type { Context } from '@earendil-works/pi-ai/compat';

export interface PromptCachePolicy {
  kind: 'openai' | 'anthropic';
  ttlMs: number;
  writeMultiplier: number;
}

// Only documented OpenRouter cache controls are enabled. Unknown providers keep
// their SDK defaults. Subscription and managed transports never use this policy.
export function promptCachePolicy(model: string): PromptCachePolicy | undefined {
  if (/^openai\/gpt-(?:5\.(?:[6-9]|\d{2,})|[6-9]|\d{2,})(?:[-./]|$)/.test(model)) {
    return { kind: 'openai', ttlMs: 12 * 60 * 60_000, writeMultiplier: 2.5 };
  }
  if (model.startsWith('anthropic/claude-')) {
    return { kind: 'anthropic', ttlMs: 60 * 60_000, writeMultiplier: 2 };
  }
  return undefined;
}

export function promptCacheEnabled(): boolean {
  return process.env.O8_PROMPT_CACHE_WARMING !== 'off';
}

/** Stable instructions and tools only. No conversation, tool results or task content. */
export function cachePrefixContext(context: Context): Context | undefined {
  const prefix = [];
  for (const message of context.messages) {
    if (message.role !== 'system') break;
    prefix.push(message);
  }
  if (!context.systemPrompt && !prefix.length) return undefined;
  return structuredClone({ ...context, messages: [...prefix, { role: 'user', content: '.', timestamp: 0 }] });
}

/** Apply markers to the exact SDK wire body, preserving the real request prefix. */
export function applyPromptCache(body: string, policy: PromptCachePolicy): string {
  const value = JSON.parse(body);
  const system = [];
  for (const message of value.messages ?? []) {
    if (message.role !== 'system' && message.role !== 'developer') break;
    system.push(message);
  }
  if (!system.length) return body;
  // Pi supplies short-lived Anthropic markers on messages. Remove them before
  // installing a single long-lived prefix boundary (mixed TTL ordering matters).
  for (const message of value.messages ?? []) {
    for (const block of Array.isArray(message.content) ? message.content : []) {
      delete block.cache_control;
      delete block.prompt_cache_breakpoint;
    }
  }
  for (const tool of value.tools ?? []) {
    delete tool.cache_control;
    delete tool.prompt_cache_breakpoint;
  }
  const last = system.at(-1);
  if (typeof last.content === 'string') last.content = [{ type: 'text', text: last.content }];
  const block = last.content?.findLast((entry: { type: string }) => entry.type === 'text');
  if (!block) return body;
  if (policy.kind === 'openai') {
    block.prompt_cache_breakpoint = { mode: 'explicit' };
    value.prompt_cache_options = { mode: 'explicit', ttl: '12h' };
  } else {
    block.cache_control = { type: 'ephemeral', ttl: '1h' };
  }
  // No task text, timestamp, credential, or reasoning effort in routing identity.
  // Model identity, instructions and tools still invalidate the prefix normally.
  value.prompt_cache_key = createHash('sha256').update(JSON.stringify({ model: value.model,
    system, tools: value.tools })).digest('hex');
  return JSON.stringify(value);
}
