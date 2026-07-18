import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import {
  appendOrchestratorDeliveryFailureEntry,
  armOrchestratorSendWatchdog,
  deliverOrchestratorPayload,
  isOrchestratorSendSettlementEvent,
  settleOrchestratorSendWatchdog,
  type PendingOrchestratorSend,
} from './delivery';
import {
  listPersistedOrchestratorPendingSends,
  ORCHESTRATOR_PENDING_SEND_STALE_MS,
  persistOrchestratorPendingSend,
  readPersistedOrchestratorPendingSend,
  settlePersistedOrchestratorPendingSend,
  type PersistedOrchestratorPendingSend,
} from './pending-send-store';
import { formatTimestampLabel } from './shared';

interface DurablePendingSendOptions {
  repoPath: string | null;
  threadId: string | null;
  pendingRef: MutableRefObject<PendingOrchestratorSend | null>;
  messagesRef: MutableRefObject<MobileTranscriptEntry[]>;
  setMessages: Dispatch<SetStateAction<MobileTranscriptEntry[]>>;
  getWebSocket: () => WebSocket | null;
  connect: () => void;
  setStatusBusy: () => void;
  setStatusReady: () => void;
}

interface OrchestratorActivity {
  event: string;
  data?: Record<string, unknown>;
  observedAt: number;
}

function pendingUserEntry(record: PersistedOrchestratorPendingSend): MobileTranscriptEntry {
  return {
    id: `orch-user-${record.clientMessageId}`,
    role: 'user',
    text: record.displayMessage,
    timestamp: record.sentAtMs,
    timestampLabel: formatTimestampLabel(record.sentAtMs),
  };
}

function fallbackWirePayload(record: PersistedOrchestratorPendingSend, repoPath: string): string {
  return JSON.stringify({
    type: 'orchestrator-send',
    repoPath,
    threadId: record.threadId,
    clientMessageId: record.clientMessageId,
    message: record.text,
    displayMessage: record.displayMessage,
  });
}

export function useDurablePendingSend(options: DurablePendingSendOptions) {
  const {
    repoPath, threadId, pendingRef, messagesRef, setMessages,
    getWebSocket, connect, setStatusBusy, setStatusReady,
  } = options;
  const activeRecordRef = useRef<PersistedOrchestratorPendingSend | null>(null);

  const ensureUserBubble = useCallback((record: PersistedOrchestratorPendingSend) => {
    setMessages((prev) => {
      if (prev.some((entry) => entry.id === `orch-user-${record.clientMessageId}`)) return prev;
      const next = [...prev, pendingUserEntry(record)];
      messagesRef.current = next;
      return next;
    });
  }, [messagesRef, setMessages]);

  const removeFailureEntry = useCallback((clientMessageId: string) => {
    setMessages((prev) => {
      const next = prev.filter((entry) => entry.id !== `orch-delivery-error-${clientMessageId}`);
      if (next.length === prev.length) return prev;
      messagesRef.current = next;
      return next;
    });
  }, [messagesRef, setMessages]);

  const settleRecord = useCallback((record: PersistedOrchestratorPendingSend) => {
    settlePersistedOrchestratorPendingSend(record.threadId, record.clientMessageId);
    removeFailureEntry(record.clientMessageId);
    if (activeRecordRef.current?.clientMessageId === record.clientMessageId) activeRecordRef.current = null;
  }, [removeFailureEntry]);

  const armRecord = useCallback((record: PersistedOrchestratorPendingSend, deliveredAt: number) => {
    activeRecordRef.current = record;
    armOrchestratorSendWatchdog({
      clientMessageId: record.clientMessageId,
      deliveredAt,
      originalText: record.displayMessage,
      pendingRef,
      setStatusReady,
      setMessages,
      messagesRef,
      onSettled: () => settleRecord(record),
    });
  }, [messagesRef, pendingRef, setMessages, setStatusReady, settleRecord]);

  const deliverRecord = useCallback(async (record: PersistedOrchestratorPendingSend) => {
    if (!repoPath) return false;
    return deliverOrchestratorPayload({
      payload: record.wirePayload ?? fallbackWirePayload(record, repoPath),
      getWebSocket,
      connect,
    });
  }, [connect, getWebSocket, repoPath]);

  const recordPending = useCallback((record: PersistedOrchestratorPendingSend) => {
    activeRecordRef.current = record;
    persistOrchestratorPendingSend(record);
  }, []);

  const failPending = useCallback((record: PersistedOrchestratorPendingSend) => {
    setStatusReady();
    appendOrchestratorDeliveryFailureEntry(setMessages, messagesRef, {
      id: `orch-delivery-error-${record.clientMessageId}`,
      originalText: record.displayMessage,
    });
  }, [messagesRef, setMessages, setStatusReady]);

  const observeActivity = useCallback((event: OrchestratorActivity) => {
    const record = activeRecordRef.current;
    if (settleOrchestratorSendWatchdog(pendingRef, event)) return;
    const ackClientMessageId = event.event === 'send-ack' && typeof event.data?.clientMessageId === 'string'
      ? event.data.clientMessageId
      : null;
    if (ackClientMessageId && threadId) {
      const ackRecord = readPersistedOrchestratorPendingSend(threadId, ackClientMessageId);
      if (ackRecord) settleRecord(ackRecord);
      return;
    }
    if (record && isOrchestratorSendSettlementEvent({
      clientMessageId: record.clientMessageId,
      deliveredAt: record.sentAtMs,
    }, event)) {
      settleRecord(record);
      return;
    }
    if (
      record
      && event.event === 'status'
      && event.data?.snapshot === true
    ) {
      void deliverRecord(record);
    }
  }, [deliverRecord, pendingRef, settleRecord, threadId]);

  const retryPending = useCallback(async (clientMessageId: string) => {
    if (!threadId) return;
    const record = readPersistedOrchestratorPendingSend(threadId, clientMessageId);
    if (!record) return;
    ensureUserBubble(record);
    removeFailureEntry(clientMessageId);
    recordPending(record);
    setStatusBusy();
    const delivered = await deliverRecord(record);
    if (delivered) armRecord(record, Date.now());
    else failPending(record);
  }, [armRecord, deliverRecord, ensureUserBubble, failPending, recordPending, removeFailureEntry, setStatusBusy, threadId]);

  useEffect(() => {
    const activeRecord = activeRecordRef.current;
    if (!threadId || (activeRecord && activeRecord.threadId !== threadId)) {
      if (pendingRef.current) clearTimeout(pendingRef.current.timeoutId);
      pendingRef.current = null;
      activeRecordRef.current = null;
    }
    if (!threadId) return;
    const records = listPersistedOrchestratorPendingSends(threadId);
    if (records.length === 0) {
      activeRecordRef.current = null;
      return;
    }
    const newest = records[records.length - 1];
    if (activeRecordRef.current?.clientMessageId === newest.clientMessageId) return;
    for (const record of records) ensureUserBubble(record);

    activeRecordRef.current = newest;
    if (Date.now() - newest.sentAtMs >= ORCHESTRATOR_PENDING_SEND_STALE_MS) {
      failPending(newest);
      return;
    }
    setStatusBusy();
    armRecord(newest, newest.sentAtMs);
  }, [armRecord, ensureUserBubble, failPending, pendingRef, setStatusBusy, threadId]);

  return { armRecord, failPending, observeActivity, recordPending, retryPending };
}
