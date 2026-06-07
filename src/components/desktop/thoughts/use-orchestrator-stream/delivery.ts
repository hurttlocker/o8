import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { formatTimestampLabel } from './shared';

const RETRY_INTERVAL_MS = 200;
export const ORCHESTRATOR_SEND_RETRY_TIMEOUT_MS = 5000;

interface DeliverOrchestratorPayloadOptions {
  payload: string;
  getWebSocket: () => WebSocket | null;
  connect: () => void;
}

export function createOrchestratorDeliveryFailureEntry(): MobileTranscriptEntry {
  const timestamp = Date.now();
  return {
    id: `orch-delivery-error-${timestamp}`,
    role: 'system',
    text: 'Couldn\'t reach the orchestrator — please re-send.',
    timestamp,
    timestampLabel: formatTimestampLabel(timestamp),
  };
}

export function appendOrchestratorDeliveryFailureEntry(
  setMessages: Dispatch<SetStateAction<MobileTranscriptEntry[]>>,
  messagesRef: MutableRefObject<MobileTranscriptEntry[]>,
): void {
  const failureEntry = createOrchestratorDeliveryFailureEntry();
  setMessages((prev) => {
    const next = [...prev, failureEntry];
    messagesRef.current = next;
    return next;
  });
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
      if (timeout !== null) window.clearTimeout(timeout);
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
