import type { MobileTranscriptEntry } from '@/lib/mobile/types';

/** Bound each answer and tool result separately so a tool-heavy turn cannot
 * push the assistant's findings out of the excerpt. */
export function clipCompactionText(text: string): string {
  const omitted = text.length - 1_400;
  return omitted > 0
    ? `${text.slice(0, 400)}\n[... ${omitted} characters omitted ...]\n${text.slice(-1_000)}`
    : text;
}

export function compactionEntryText(entry: MobileTranscriptEntry, clip = (text: string) => text): string {
  if (entry.type === 'compaction') {
    return clip((entry.compaction?.summary ?? entry.text).replace(/<\/?compacted_context\b[^>]*>/gi, '').trim());
  }
  return [
    clip(entry.text.trim()),
    ...entry.toolCalls?.map((tool) => [
      `Tool: ${tool.name}${tool.status ? ` (${tool.status})` : ''}`,
      tool.result || tool.preview ? clip(tool.result || tool.preview || '') : '[no result]',
    ].join('\n')) ?? [],
  ].filter(Boolean).join('\n\n');
}
