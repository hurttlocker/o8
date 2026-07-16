import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { formatTimestampLabel } from './shared';

const RETRY_INTERVAL_MS = 200;
export const ORCHESTRATOR_SEND_RETRY_TIMEOUT_MS = 5000;
export const ORCHESTRATOR_SEND_ACK_TIMEOUT_MS = 4000;

interface DeliverOrchestratorPayloadOptions {
  payload: string;
  getWebSocket: () => WebSocket | null;
  connect: () => void;
}

export interface PendingOrchestratorSend {
  clientMessageId: string;
  deliveredAt: number;
  originalText: string;
  timeoutId: ReturnType<typeof setTimeout>;
  failureEntryId: string;
}

interface ArmOrchestratorSendWatchdogOptions {
  clientMessageId: string;
  deliveredAt: number;
  originalText: string;
  pendingRef: MutableRefObject<PendingOrchestratorSend | null>;
  setStatusReady: () => void;
  setMessages: Dispatch<SetStateAction<MobileTranscriptEntry[]>>;
  messagesRef: MutableRefObject<MobileTranscriptEntry[]>;
  timeoutMs?: number;
}

interface OrchestratorWatchdogEvent {
  event: string;
  data?: Record<string, unknown>;
  observedAt: number;
}

export function createOrchestratorClientMessageId(): string {
  return `orch-send-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function createOrchestratorDeliveryFailureEntry(options?: {
  id?: string;
  originalText?: string;
}): MobileTranscriptEntry {
  const timestamp = Date.now();
  const hasOriginalText = typeof options?.originalText === 'string' && options.originalText.trim().length > 0;
  return {
    id: options?.id ?? `orch-delivery-error-${timestamp}`,
    role: 'system',
    text: hasOriginalText
      ? `Message may not have been delivered — the bridge was still starting. Tap to retry.\n\n${options.originalText}`
      : 'Couldn\'t reach the orchestrator — please re-send.',
    isError: true,
    timestamp,
    timestampLabel: formatTimestampLabel(timestamp),
  };
}

export function appendOrchestratorDeliveryFailureEntry(
  setMessages: Dispatch<SetStateAction<MobileTranscriptEntry[]>>,
  messagesRef: MutableRefObject<MobileTranscriptEntry[]>,
  options?: { id?: string; originalText?: string },
): void {
  const failureEntry = createOrchestratorDeliveryFailureEntry(options);
  setMessages((prev) => {
    if (prev.some((entry) => entry.id === failureEntry.id)) {
      messagesRef.current = prev;
      return prev;
    }
    const next = [...prev, failureEntry];
    messagesRef.current = next;
    return next;
  });
}

function clearPendingOrchestratorSend(pending: PendingOrchestratorSend): void {
  clearTimeout(pending.timeoutId);
}

export function armOrchestratorSendWatchdog({
  clientMessageId,
  deliveredAt,
  originalText,
  pendingRef,
  setStatusReady,
  setMessages,
  messagesRef,
  timeoutMs = ORCHESTRATOR_SEND_ACK_TIMEOUT_MS,
}: ArmOrchestratorSendWatchdogOptions): void {
  if (pendingRef.current) clearPendingOrchestratorSend(pendingRef.current);
  const failureEntryId = `orch-delivery-error-${clientMessageId}`;
  const timeoutId = setTimeout(() => {
    const pending = pendingRef.current;
    if (!pending || pending.clientMessageId !== clientMessageId) return;
    pendingRef.current = null;
    setStatusReady();
    appendOrchestratorDeliveryFailureEntry(setMessages, messagesRef, {
      id: failureEntryId,
      originalText,
    });
  }, timeoutMs);
  pendingRef.current = { clientMessageId, deliveredAt, originalText, timeoutId, failureEntryId };
}

function isLiveOrchestratorActivity(eventName: string, data?: Record<string, unknown>): boolean {
  if (data?.snapshot === true) return false;
  return eventName === 'status'
    || eventName === 'output'
    || eventName === 'tool-use'
    || eventName === 'tool-result'
    || eventName === 'collide-phase'
    || eventName === 'collide-proposal'
    || eventName === 'error';
}

export function settleOrchestratorSendWatchdog(
  pendingRef: MutableRefObject<PendingOrchestratorSend | null>,
  event: OrchestratorWatchdogEvent,
): boolean {
  const pending = pendingRef.current;
  if (!pending) return false;

  const isMatchingAck = event.event === 'send-ack'
    && event.data?.clientMessageId === pending.clientMessageId;
  const isPostSendActivity = event.observedAt >= pending.deliveredAt
    && isLiveOrchestratorActivity(event.event, event.data);
  if (!isMatchingAck && !isPostSendActivity) return false;

  clearPendingOrchestratorSend(pending);
  pendingRef.current = null;
  return true;
}

export async function deliverOrchestratorPayload({
  payload,
  getWebSocket,
  connect,
}: DeliverOrchestratorPayloadOptions): Promise<boolean> {
  const sendPayload = (ws: WebSocket): boolean => {
    try {
      ws.send(payload);
      return true;
    } catch {
      return false;
    }
  };

  const openWs = getWebSocket();
  if (openWs?.readyState === WebSocket.OPEN) {
    if (sendPayload(openWs)) return true;
  }

  connect();

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let interval: number | null = null;
    let timeout: number | null = null;

    const finish = (delivered: boolean) => {
      if (settled) return;
      settled = true;
      if (interval !== null) window.clearInterval(interval);
      if (timeout !== null) clearTimeout(timeout);
      resolve(delivered);
    };

    const tryDeliver = () => {
      const currentWs = getWebSocket();
      if (currentWs?.readyState !== WebSocket.OPEN) return;
      if (sendPayload(currentWs)) finish(true);
    };

    interval = window.setInterval(tryDeliver, RETRY_INTERVAL_MS);
    timeout = window.setTimeout(() => finish(false), ORCHESTRATOR_SEND_RETRY_TIMEOUT_MS);
    tryDeliver();
  });
}
