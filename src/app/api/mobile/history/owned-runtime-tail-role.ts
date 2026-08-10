import type { MobileTranscriptEntry } from '@/lib/mobile/types';

export function ownedRuntimeTailRole(kind: string, label: string): MobileTranscriptEntry['role'] {
  if (kind === 'message') return 'assistant';
  return runtimeTailRole(label);
}

export function runtimeTailRole(label: string): MobileTranscriptEntry['role'] {
  const normalized = label.toLowerCase();
  if (normalized.includes('assistant')) return 'assistant';
  if (normalized.includes('user')) return 'user';
  if (normalized.includes('tool')) return 'tool';
  return 'system';
}
