'use client';

import type { ElementEditContext } from '@/lib/browser/edit-context';

export interface WarmUiLoopPacket {
  packetId: string;
  laneId: string;
  lastActivityAt: string;
  label: string;
}

export type UiLoopEditOutcome =
  | { kind: 'steered'; packet: WarmUiLoopPacket }
  | { kind: 'fallback'; reason: string }
  | { kind: 'error'; message: string };

interface OperatorEnvelope<T> {
  ok?: boolean;
  result?: T;
  error?: { message?: string } | string;
}

function fallback(reason: string, injectFallback: () => void): UiLoopEditOutcome {
  injectFallback();
  return { kind: 'fallback', reason };
}

function errorMessage(payload: OperatorEnvelope<unknown> | null): string {
  if (typeof payload?.error === 'string') return payload.error;
  return payload?.error?.message ?? 'The warm packet could not accept this edit.';
}

export async function routeUiLoopEdit(input: {
  repoPath?: string | null;
  context: ElementEditContext;
  forceFresh: boolean;
  injectFallback: () => void;
}): Promise<UiLoopEditOutcome> {
  const repoPath = input.repoPath?.trim() ?? '';
  if (input.forceFresh || !repoPath) {
    return fallback(input.forceFresh ? 'FORCED_FRESH' : 'NO_REPO', input.injectFallback);
  }

  let lookupResponse: Response;
  try {
    lookupResponse = await fetch(`/api/orchestrator/ui-loop?repo=${encodeURIComponent(repoPath)}`);
  } catch {
    return fallback('LOOKUP_UNAVAILABLE', input.injectFallback);
  }
  const lookup = await lookupResponse.json().catch(() => null) as OperatorEnvelope<WarmUiLoopPacket | null> | null;
  if (!lookupResponse.ok || !lookup?.result) {
    return fallback(lookupResponse.ok ? 'NO_WARM_UI_LOOP_PACKET' : 'LOOKUP_FAILED', input.injectFallback);
  }

  let steerResponse: Response;
  try {
    steerResponse = await fetch('/api/orchestrator/ui-loop/steer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repo: repoPath,
        text: input.context.text,
        previewImageDataUri: input.context.previewImageDataUri,
      }),
    });
  } catch {
    return { kind: 'error', message: 'The steer response was lost. Check the running packet before retrying.' };
  }
  const payload = await steerResponse.json().catch(() => null) as OperatorEnvelope<{
    kind?: string;
    packet?: WarmUiLoopPacket;
    reason?: string;
  }> | null;
  if (steerResponse.ok && payload?.result?.kind === 'steered' && payload.result.packet) {
    return { kind: 'steered', packet: payload.result.packet };
  }
  if (steerResponse.ok && payload?.result?.kind === 'fallback') {
    return fallback(payload.result.reason ?? 'NO_STEERABLE_SESSION', input.injectFallback);
  }
  return { kind: 'error', message: errorMessage(payload) };
}
