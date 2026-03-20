import type {
  RealtimeInternalRequest,
  RealtimeMutationPublishRequest,
  RealtimeRefreshRequest,
} from '@/lib/realtime/types';

const REALTIME_INTERNAL_ORIGIN = process.env.CORTEX_REALTIME_INTERNAL_ORIGIN ?? 'http://127.0.0.1:3002';
const REALTIME_INTERNAL_TIMEOUT_MS = 2_500;
const WS_TOKEN = process.env.WS_TOKEN ?? 'cortex-ide';

async function postInternalRealtimeRequest(payload: RealtimeInternalRequest) {
  try {
    await fetch(`${REALTIME_INTERNAL_ORIGIN}/internal/realtime`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REALTIME_INTERNAL_TIMEOUT_MS),
    });
  } catch {
    // Best-effort: the app must remain correct even if the local WS bridge
    // is not running yet. Poll fallback still reconciles eventually.
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
