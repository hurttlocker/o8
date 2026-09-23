import type { MobileTranscriptEntry } from '@/lib/mobile/types';

export function optimisticUserEntry(input: {
  id: string;
  text: string;
  timestamp: number;
  timestampLabel: string;
  attachments?: Array<{ dataUri: string; name?: string }>;
}): MobileTranscriptEntry {
  return {
    id: input.id,
    role: 'user',
    text: input.text,
    timestamp: input.timestamp,
    timestampLabel: input.timestampLabel,
    ...(input.attachments?.length ? {
      media: input.attachments.map((attachment) => ({
        kind: 'image' as const,
        path: attachment.dataUri,
        name: attachment.name || 'Image',
      })),
    } : {}),
  };
}
