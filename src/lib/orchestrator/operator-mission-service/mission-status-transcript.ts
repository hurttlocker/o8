import {
  latestTranscriptEventAt,
  readSessionTranscriptEvents,
} from '@/lib/orchestrator/packet-transcript';

interface MissionTranscriptActivity {
  lastTranscriptAt: string | null;
  transcriptUnsupportedReason: string | null;
}

export function latestIsoTimestamp(...timestamps: Array<string | null | undefined>): string | null {
  let latestMs = 0;
  let latestIso: string | null = null;
  for (const timestamp of timestamps) {
    if (!timestamp) continue;
    const parsed = new Date(timestamp).getTime();
    if (!Number.isFinite(parsed) || parsed <= latestMs) continue;
    latestMs = parsed;
    latestIso = new Date(parsed).toISOString();
  }
  return latestIso;
}

export function activityLabel(
  lastActivityAt: string | null,
  lastTranscriptAt: string | null,
  lastEventLabel: string | null | undefined,
) {
  return lastActivityAt && lastTranscriptAt && lastActivityAt === lastTranscriptAt
    ? 'transcript_activity'
    : lastEventLabel ?? null;
}

export async function readTranscriptActivityBySession(
  sessionKeys: string[],
): Promise<Map<string, MissionTranscriptActivity>> {
  const uniqueKeys = [...new Set(sessionKeys.map((key) => key.trim()).filter(Boolean))];
  const pairs = await Promise.all(uniqueKeys.map(async (sessionKey) => {
    try {
      const readback = await readSessionTranscriptEvents(sessionKey);
      return [sessionKey, {
        lastTranscriptAt: latestTranscriptEventAt(readback.events),
        transcriptUnsupportedReason: readback.unsupportedReason ?? null,
      }] as const;
    } catch {
      return [sessionKey, {
        lastTranscriptAt: null,
        transcriptUnsupportedReason: null,
      }] as const;
    }
  }));
  return new Map(pairs);
}
