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
  | { kind: 'queued'; packet: WarmUiLoopPacket; position: number }
  | { kind: 'blocked'; packet: WarmUiLoopPacket; reason: string }
  | { kind: 'rejected'; reason: 'queue_full' }
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
        previewUrl: input.context.previewUrl,
        readySelector: input.context.readySelector,
        readyText: input.context.readyText,
        element: input.context.element,
        elementRect: input.context.elementRect,
        elementFilePath: input.context.elementFilePath,
      }),
    });
  } catch {
    return { kind: 'error', message: 'The steer response was lost. Check the running packet before retrying.' };
  }
  const payload = await steerResponse.json().catch(() => null) as OperatorEnvelope<{
    kind?: string;
    packet?: WarmUiLoopPacket;
    reason?: string;
    queued?: boolean;
    position?: number;
    blocked?: string;
    rejected?: string;
  }> | null;
  if (steerResponse.ok && payload?.result?.kind === 'steered' && payload.result.packet) {
    return { kind: 'steered', packet: payload.result.packet };
  }
  if (steerResponse.ok && payload?.result?.kind === 'fallback') {
    return fallback(payload.result.reason ?? 'NO_STEERABLE_SESSION', input.injectFallback);
  }
  if (steerResponse.ok
    && payload?.result?.queued === true
    && payload.result.packet
    && typeof payload.result.position === 'number') {
    return { kind: 'queued', packet: payload.result.packet, position: payload.result.position };
  }
  if (steerResponse.ok && payload?.result?.blocked && payload.result.packet) {
    return { kind: 'blocked', packet: payload.result.packet, reason: payload.result.blocked };
  }
  if (steerResponse.ok && payload?.result?.rejected === 'queue_full') {
    return { kind: 'rejected', reason: 'queue_full' };
  }
  return { kind: 'error', message: errorMessage(payload) };
}

export async function showUiLoopProof(packet: WarmUiLoopPacket): Promise<void> {
  const laneResponse = await fetch(`/api/lanes/${encodeURIComponent(packet.laneId)}?events=500`);
  const lanePayload = await laneResponse.json().catch(() => null) as {
    events?: Array<{ id?: string; verb?: string; payload?: Record<string, unknown> }>;
  } | null;
  const proof = [...(lanePayload?.events ?? [])].reverse().find((event) => event.verb === 'ui_loop_proof');
  if (!laneResponse.ok || !proof?.payload) throw new Error('Proof is not ready yet.');
  const proofId = typeof proof.payload.proofId === 'string' && proof.payload.proofId.trim()
    ? proof.payload.proofId.trim()
    : proof.id ?? `${packet.laneId}:latest`;
  const response = await fetch('/api/canvas/intent', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      verb: 'ui-loop-proof',
      args: { ...proof.payload, proofId },
      ensure: true,
    }),
  });
  const payload = await response.json().catch(() => null) as { ok?: boolean; error?: string } | null;
  if (!response.ok || payload?.ok === false) throw new Error(payload?.error ?? 'The proof card could not open.');
}
