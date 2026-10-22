import 'server-only';
import { resolveProviderKey, updateManagedProviderKey, clearManagedProviderKey } from '@/lib/providers/key-store';
import { isOpenRouterEnabled } from '@/lib/providers/openrouter-connection';

export function updateManagedOpenRouterKey(value: string | null): void {
  updateManagedProviderKey('OPENROUTER_API_KEY', value);
}
export async function resolveOpenRouterKey(): Promise<string | null> {
  if (!isOpenRouterEnabled()) {
    // Clear only hydrated values. Explicit shell credentials remain caller-owned.
    clearManagedProviderKey('OPENROUTER_API_KEY');
    return null;
  }
  const value = resolveProviderKey('OPENROUTER_API_KEY');
  return value;
}
export async function resolveOpenAIKey(): Promise<string | null> {
  return resolveProviderKey('OPENAI_API_KEY');
}
export async function isByokRequired(): Promise<boolean> {
  return process.env.O8_BYOK_REQUIRED === '1' && !(await resolveOpenRouterKey());
}
