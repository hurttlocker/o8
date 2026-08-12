import type { OwnedTailEntry, OwnedTailGroup } from './owned-session';
import type { RuntimeTranscriptEntry } from '../types';

interface OwnedTranscriptTail {
  entries: OwnedTailEntry[];
  groups: OwnedTailGroup[];
}

function transcriptTimestamp(value?: string, fallback?: string): Date {
  const direct = value ? new Date(value) : null;
  if (direct && !Number.isNaN(direct.getTime())) return direct;
  const fallbackTimestamp = fallback ? new Date(fallback) : null;
  return fallbackTimestamp && !Number.isNaN(fallbackTimestamp.getTime())
    ? fallbackTimestamp
    : new Date();
}

function runtimeEntry(
  entry: OwnedTailEntry,
  fallbackTimestamp?: string,
): RuntimeTranscriptEntry {
  return {
    id: entry.id,
    role: entry.kind === 'message' ? 'assistant'
      : entry.kind === 'tool' ? 'tool'
      : 'system',
    text: entry.text,
    timestamp: transcriptTimestamp(entry.timestamp, fallbackTimestamp),
    toolName: entry.kind === 'tool' ? entry.label : undefined,
  };
}

function applyTranscriptWindow(
  entries: RuntimeTranscriptEntry[],
  sinceId?: string,
  limit?: number,
): RuntimeTranscriptEntry[] {
  let next = entries;
  if (sinceId) {
    const sinceIndex = next.findIndex((entry) => entry.id === sinceId);
    if (sinceIndex >= 0) next = next.slice(sinceIndex + 1);
  }
  if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0 && next.length > limit) {
    next = next.slice(-limit);
  }
  return next;
}

/**
 * Normalize the shared owned-session tail without losing the user turn stored
 * on each group. Some parsers also emit a prompt event inside `group.entries`;
 * the stable prompt id keeps that duplicate out while preserving the user role.
 */
export function ownedTailToRuntimeTranscript(
  tail: OwnedTranscriptTail,
  sinceId?: string,
  limit?: number,
): RuntimeTranscriptEntry[] {
  const entries: RuntimeTranscriptEntry[] = [];
  const seenIds = new Set<string>();

  const append = (entry: RuntimeTranscriptEntry) => {
    if (seenIds.has(entry.id)) return;
    seenIds.add(entry.id);
    entries.push(entry);
  };

  for (const group of tail.groups) {
    const promptId = `${group.id}:prompt`;
    const prompt = group.prompt.trim();
    if (prompt) {
      append({
        id: promptId,
        role: 'user',
        text: prompt,
        timestamp: transcriptTimestamp(group.startedAt),
      });
    }
    for (const entry of group.entries) {
      const isDuplicatePrompt = entry.id === promptId
        || (prompt
          && entry.text.trim() === prompt
          && entry.label.toLowerCase().includes('prompt'));
      if (isDuplicatePrompt) continue;
      append(runtimeEntry(entry, group.finishedAt ?? group.startedAt));
    }
  }

  // Older or partially written tails may not have group metadata yet. Keep
  // their raw entries readable, while the id set prevents normal tails from
  // being duplicated.
  for (const entry of tail.entries) {
    append(runtimeEntry(entry));
  }

  return applyTranscriptWindow(entries, sinceId, limit);
}
