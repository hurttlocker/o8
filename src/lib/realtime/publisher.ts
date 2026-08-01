import type {
  RealtimeInternalRequest,
  RealtimeMutationPublishRequest,
  RealtimeRefreshRequest,
} from '@/lib/realtime/types';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import { getWsBase } from '@/lib/panel/api-port';

const REALTIME_INTERNAL_ORIGIN = process.env.CORTEX_REALTIME_INTERNAL_ORIGIN ?? getWsBase();
const REALTIME_INTERNAL_TIMEOUT_MS = 2_500;

async function postInternalRealtimeRequest(payload: RealtimeInternalRequest) {
  try {
    const response = await fetch(`${REALTIME_INTERNAL_ORIGIN}/internal/realtime`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${getOrCreateWsToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REALTIME_INTERNAL_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    // Best-effort: the app must remain correct even if the local WS bridge
    // is not running yet. Poll fallback still reconciles eventually.
    return false;
  }
}

export async function requestRealtimeRefresh(request: Omit<RealtimeRefreshRequest, 'kind'>) {
  return postInternalRealtimeRequest({
    kind: 'refresh',
    ...request,
  });
}

export async function publishRealtimeMutation(request: Omit<RealtimeMutationPublishRequest, 'kind'>) {
  return postInternalRealtimeRequest({
    kind: 'mutation',
    ...request,
  });
}

/**
 * #840 — Lightweight broadcast for Cortex memory mutations the UI cares
 * about (directives, outcomes, codebase-memory). The ws-server fans this
 * out as a `cortex-changes` channel event, which the desktop WS context
 * bridges to an `o8:cortex-changes` window event. The Recall Card and
 * Packet Review Card listen for this and re-fetch their data without a
 * full page reload.
 *
 * Best-effort — never throws, never blocks the merge path.
 */
export async function publishCortexChange(payload: {
  scope: 'directive' | 'outcome' | 'codebase-memory';
  /** Repo path the change applies to, when known. */
  repoPath?: string;
  /** Free-form reason for logs (e.g. `merge:packet-123`). */
  reason?: string;
}) {
  try {
    await fetch(`${REALTIME_INTERNAL_ORIGIN}/internal/cortex-changes`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${getOrCreateWsToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REALTIME_INTERNAL_TIMEOUT_MS),
    });
  } catch {
    // Best-effort — UI still has poll fallback.
  }
}

/**
 * #1147 Phase 2 — live visual-proof. After an agent records a before/after
 * still (POST /api/panel/artifacts), fan out an `artifacts` channel event so
 * the mounted proof strips (PacketCard, PrPanel, mission-complete) refetch
 * live instead of waiting for the next mount/poll. Carries only identifiers —
 * clients refetch the authoritative list via GET /api/panel/artifacts.
 *
 * Best-effort — never throws, never blocks the ingest path.
 */
export async function publishArtifactRecorded(payload: {
  artifactId: string;
  packetId?: string | null;
  prNumber?: number | null;
  laneId?: string | null;
}) {
  try {
    await fetch(`${REALTIME_INTERNAL_ORIGIN}/internal/artifacts`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${getOrCreateWsToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REALTIME_INTERNAL_TIMEOUT_MS),
    });
  } catch {
    // Best-effort — UI still has its mount/poll fetch.
  }
}
