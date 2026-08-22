import type { Lane } from './types';
import {
  latestTranscriptEventAt,
  readSessionTranscriptEvents,
} from '@/lib/orchestrator/packet-transcript';

export const RUNNING_TRANSCRIPT_STALL_MS = 2 * 60_000;
const TRANSCRIPT_ACTIVITY_CACHE_MS = 750;

export interface LaneTranscriptFault {
  code: 'transcript_stalled' | 'transcript_read_failed';
  message: string;
  stalledForMs: number | null;
  thresholdMs: number;
}

export interface LaneTranscriptHealth {
  lastTranscriptAt: string | null;
  transcriptFault: LaneTranscriptFault | null;
}

interface TranscriptActivityRead {
  lastTranscriptAt: string | null;
  readFailed: boolean;
}

const transcriptActivityCache = new Map<string, {
  expiresAt: number;
  promise: Promise<TranscriptActivityRead>;
}>();

function readTranscriptActivity(sessionKey: string): Promise<TranscriptActivityRead> {
  const now = Date.now();
  const cached = transcriptActivityCache.get(sessionKey);
  if (cached && cached.expiresAt > now) return cached.promise;

  const promise = readSessionTranscriptEvents(sessionKey)
    .then((readback) => ({
      lastTranscriptAt: latestTranscriptEventAt(readback.events),
      readFailed: false,
    }))
    .catch(() => ({ lastTranscriptAt: null, readFailed: true }));
  transcriptActivityCache.set(sessionKey, {
    expiresAt: now + TRANSCRIPT_ACTIVITY_CACHE_MS,
    promise,
  });
  return promise;
}

export function classifyLaneTranscriptFault(
  lane: Pick<Lane, 'status' | 'createdAt' | 'lastEventAt'>,
  activity: TranscriptActivityRead,
  now = Date.now(),
): LaneTranscriptFault | null {
  if (lane.status !== 'running') return null;
  if (activity.readFailed) {
    return {
      code: 'transcript_read_failed',
      message: 'The running worker transcript could not be read.',
      stalledForMs: null,
      thresholdMs: RUNNING_TRANSCRIPT_STALL_MS,
    };
  }

  const activityAt = activity.lastTranscriptAt ?? lane.lastEventAt ?? lane.createdAt;
  const activityMs = new Date(activityAt).getTime();
  if (!Number.isFinite(activityMs)) return null;
  const stalledForMs = Math.max(0, now - activityMs);
  if (stalledForMs < RUNNING_TRANSCRIPT_STALL_MS) return null;
  return {
    code: 'transcript_stalled',
    message: 'The worker is running but its transcript has stopped advancing.',
    stalledForMs,
    thresholdMs: RUNNING_TRANSCRIPT_STALL_MS,
  };
}

export async function resolveLaneTranscriptHealth(lane: Lane): Promise<LaneTranscriptHealth> {
  if (lane.status !== 'running' || !lane.sessionKey) {
    return { lastTranscriptAt: null, transcriptFault: null };
  }
  const activity = await readTranscriptActivity(lane.sessionKey);
  return {
    lastTranscriptAt: activity.lastTranscriptAt,
    transcriptFault: classifyLaneTranscriptFault(lane, activity),
  };
}
