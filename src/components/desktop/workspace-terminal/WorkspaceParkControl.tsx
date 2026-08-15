'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { useCorrelatedActionLatch } from '@/components/desktop/use-correlated-action-latch';
import {
  correlatedActionIsUnsettled,
  fetchCorrelatedActionReceipt,
} from '@/lib/orchestrator/action-receipt';

type WorkspaceAction = 'park' | 'restore';
type WorkspaceState = 'materialized' | 'parkable' | 'hibernating' | 'parked' | 'restoring';

interface PendingWorkspaceMutation {
  action: WorkspaceAction;
  packetId: string;
  clientMutationId: string;
}

const WORKSPACE_MUTATION_STORAGE_PREFIX = 'o8:workspace-mutation:';
const WORKSPACE_STATUS_POLL_MS = 750;

function workspaceMutationStorageKey(packetId: string) {
  return `${WORKSPACE_MUTATION_STORAGE_PREFIX}${packetId}`;
}

function isPendingWorkspaceMutation(value: unknown, packetId: string): value is PendingWorkspaceMutation {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<PendingWorkspaceMutation>;
  return (candidate.action === 'park' || candidate.action === 'restore')
    && candidate.packetId === packetId
    && typeof candidate.clientMutationId === 'string'
    && candidate.clientMutationId.length > 0;
}

function readPendingWorkspaceMutation(packetId: string): PendingWorkspaceMutation | null {
  try {
    const serialized = window.sessionStorage.getItem(workspaceMutationStorageKey(packetId));
    if (!serialized) return null;
    const parsed = JSON.parse(serialized) as unknown;
    if (isPendingWorkspaceMutation(parsed, packetId)) return parsed;
    window.sessionStorage.removeItem(workspaceMutationStorageKey(packetId));
  } catch {
    // Storage may be unavailable in a hardened webview. The mounted latch still
    // prevents a second action for the life of this control.
  }
  return null;
}

function claimWorkspaceMutation(packetId: string, action: WorkspaceAction): PendingWorkspaceMutation {
  const existing = readPendingWorkspaceMutation(packetId);
  if (existing) return existing;
  const mutation = { action, packetId, clientMutationId: crypto.randomUUID() };
  try {
    window.sessionStorage.setItem(workspaceMutationStorageKey(packetId), JSON.stringify(mutation));
  } catch {
    // See readPendingWorkspaceMutation. The in-memory latch remains authoritative
    // until this mounted control receives a terminal receipt.
  }
  return mutation;
}

function clearPendingWorkspaceMutation(mutation: PendingWorkspaceMutation) {
  try {
    const current = readPendingWorkspaceMutation(mutation.packetId);
    if (current?.clientMutationId === mutation.clientMutationId) {
      window.sessionStorage.removeItem(workspaceMutationStorageKey(mutation.packetId));
    }
  } catch {
    // Best-effort cleanup only; a stale terminal body safely replays its receipt.
  }
}

interface WorkspaceStatus {
  state: WorkspaceState;
  canPark: boolean;
  canRestore: boolean;
  reviewable: boolean;
  branch: string;
  reviewedHead: string | null;
  note: string | null;
}

interface WorkspaceStatusEnvelope {
  ok?: boolean;
  result?: WorkspaceStatus;
  error?: { message?: string };
}

interface WorkspaceMutationEnvelope {
  ok?: boolean;
  result?: {
    state?: WorkspaceState;
    status?: string;
    note?: string;
    outcomeUnknown?: boolean;
    inProgress?: boolean;
  };
  error?: { message?: string };
}

export function workspaceControlCopy(
  status: WorkspaceStatus,
  busy: WorkspaceAction | null,
  outcomeUncertain = false,
): { label: string; action: WorkspaceAction | null; detail: string } {
  if (busy && outcomeUncertain) {
    return { label: 'Outcome unknown', action: null, detail: 'Exact workspace mutation remains locked.' };
  }
  if (busy === 'park') {
    if (status.state === 'parkable') {
      return { label: 'Protecting review…', action: null, detail: 'Recording immutable branch and review truth.' };
    }
    if (status.state === 'hibernating') {
      return { label: 'Removing workspace copy…', action: null, detail: 'Immutable review stays available.' };
    }
    if (status.state === 'parked') {
      return { label: 'Confirming parked receipt…', action: null, detail: 'The workspace copy is removed.' };
    }
    return status.state === 'materialized'
      ? { label: 'Checking workspace…', action: null, detail: 'Verifying clean files and process state.' }
      : { label: 'Checking operation status…', action: null, detail: 'Durable workspace state changed during parking.' };
  }
  if (busy === 'restore') {
    if (status.state === 'restoring') {
      return { label: 'Recreating workspace…', action: null, detail: 'Rebuilding the exact reviewed state.' };
    }
    if (status.state === 'materialized') {
      return { label: 'Confirming restored receipt…', action: null, detail: 'The exact workspace is materialized.' };
    }
    return status.state === 'parked'
      ? { label: 'Checking restore path…', action: null, detail: 'Verifying the original path is available.' }
      : { label: 'Checking operation status…', action: null, detail: 'Durable workspace state changed during restoration.' };
  }
  if (status.state === 'parked') {
    return status.canRestore
      ? { label: 'Restore', action: 'restore', detail: 'Parked · restore available' }
      : { label: 'Restore blocked', action: null, detail: 'Parked · restore unavailable' };
  }
  if (status.state === 'hibernating') {
    return { label: 'Parking…', action: null, detail: 'Recovery is being reconciled.' };
  }
  if (status.state === 'restoring') {
    return { label: 'Restoring…', action: null, detail: 'Restore is being reconciled.' };
  }
  if (status.canPark) {
    return { label: 'Park workspace', action: 'park', detail: 'Remove rebuildable files; keep review and branch truth.' };
  }
  return { label: '', action: null, detail: '' };
}

function WorkspaceParkControlForPacket({ packetId }: { packetId: string }) {
  const [statusReceipt, setStatusReceipt] = useState<{
    packetId: string;
    status: WorkspaceStatus;
  } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcomeUncertain, setOutcomeUncertain] = useState(false);
  const [confirmingParkPacketId, setConfirmingParkPacketId] = useState<string | null>(null);
  const { busy, begin, settle } = useCorrelatedActionLatch<WorkspaceAction>();
  const resumedMutationRef = useRef<string | null>(null);
  const currentPacketIdRef = useRef(packetId);
  const statusRequestSequenceRef = useRef(0);
  currentPacketIdRef.current = packetId;
  const status = statusReceipt?.packetId === packetId ? statusReceipt.status : null;
  const confirmingPark = confirmingParkPacketId === packetId;

  const loadStatus = useCallback(async () => {
    const requestSequence = statusRequestSequenceRef.current + 1;
    statusRequestSequenceRef.current = requestSequence;
    try {
      const response = await fetch(
        `/api/orchestrator/workspace?packetId=${encodeURIComponent(packetId)}`,
        { cache: 'no-store' },
      );
      const payload = await response.json().catch(() => null) as WorkspaceStatusEnvelope | null;
      if (!response.ok || !payload?.ok || !payload.result) return;
      if (currentPacketIdRef.current !== packetId
        || statusRequestSequenceRef.current !== requestSequence) return;
      setStatusReceipt({ packetId, status: payload.result });
      setError(null);
    } catch {
      // This is an optional review-ready control. A read outage must not obscure
      // the packet's primary review actions with a second error surface.
    }
  }, [packetId]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (busy || status?.state !== 'materialized' || !status.canPark) {
      setConfirmingParkPacketId(null);
    }
  }, [busy, packetId, status]);

  useEffect(() => {
    if (!busy || outcomeUncertain) return;
    let cancelled = false;
    let handle: ReturnType<typeof setTimeout> | null = null;
    const refresh = async () => {
      // Time schedules truth reads only. Labels derive exclusively from the
      // durable state returned by the status endpoint.
      await loadStatus();
      if (!cancelled) handle = setTimeout(refresh, WORKSPACE_STATUS_POLL_MS);
    };
    handle = setTimeout(refresh, WORKSPACE_STATUS_POLL_MS);
    return () => {
      cancelled = true;
      if (handle) clearTimeout(handle);
    };
  }, [busy, loadStatus, outcomeUncertain]);

  const runAction = useCallback(async (
    action: WorkspaceAction,
    pendingMutation?: PendingWorkspaceMutation,
  ) => {
    const mutation = pendingMutation ?? claimWorkspaceMutation(packetId, action);
    if (!begin(mutation.action)) return;
    setError(null);
    setNote(null);
    setOutcomeUncertain(false);
    let retainPending = false;
    const requestBody = JSON.stringify(mutation);
    try {
      const { response, payload } = await fetchCorrelatedActionReceipt<WorkspaceMutationEnvelope>(
        '/api/orchestrator/workspace',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: requestBody,
        },
      );
      if (payload?.result?.outcomeUnknown === true) {
        retainPending = true;
        setOutcomeUncertain(true);
        setNote(payload.error?.message ?? 'The workspace outcome is unknown. Inspect its current state before acting again.');
        return;
      }
      if (!response.ok || !payload?.ok || !payload.result) {
        throw new Error(payload?.error?.message ?? `Unable to ${mutation.action} workspace.`);
      }
      clearPendingWorkspaceMutation(mutation);
      setNote(payload.result.note ?? null);
      await loadStatus();
    } catch (actionError) {
      if (correlatedActionIsUnsettled(actionError)) {
        retainPending = true;
        setOutcomeUncertain(true);
        setNote(actionError.message);
      } else {
        clearPendingWorkspaceMutation(mutation);
        setError(actionError instanceof Error ? actionError.message : `Unable to ${mutation.action} workspace.`);
      }
    } finally {
      if (!retainPending) setOutcomeUncertain(false);
      settle(retainPending);
    }
  }, [begin, loadStatus, packetId, settle]);

  useEffect(() => {
    const pendingMutation = readPendingWorkspaceMutation(packetId);
    if (!pendingMutation || resumedMutationRef.current === pendingMutation.clientMutationId) return;
    resumedMutationRef.current = pendingMutation.clientMutationId;
    void runAction(pendingMutation.action, pendingMutation);
  }, [packetId, runAction]);

  if (!status) return null;
  const copy = workspaceControlCopy(status, busy, outcomeUncertain);
  if (!copy.label && !copy.detail) return null;
  const disabled = busy !== null || copy.action === null;
  const confirmationButtonStyle = {
    minHeight: 44,
    paddingTop: 5,
    paddingRight: 9,
    paddingBottom: 5,
    paddingLeft: 9,
    borderRadius: 8,
    borderWidth: 1,
    borderStyle: 'solid',
    fontSize: 11,
    fontFamily: 'var(--font-sans-system)',
    cursor: 'pointer',
  } as const;

  return (
    <div aria-live="polite" style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
      paddingTop: 6,
      paddingRight: 8,
      paddingBottom: 6,
      paddingLeft: 8,
      borderRadius: 8,
      borderWidth: 1,
      borderStyle: 'solid',
      borderColor: 'var(--t-panel-border)',
      backgroundColor: 'var(--t-panel)',
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{
          fontSize: 10.5,
          fontWeight: 400,
          color: status.state === 'parked' ? 'var(--t-brand-orange)' : 'var(--t-text-secondary)',
          lineHeight: 1.35,
        }}>
          {copy.detail}
        </div>
        {note || error || status.note ? (
          <div style={{
            marginTop: 2,
            fontSize: 10,
            fontWeight: 300,
            color: error ? 'var(--t-brand-red)' : 'var(--t-text-muted)',
            lineHeight: 1.35,
          }}>
            {error ?? note ?? status.note}
          </div>
        ) : null}
      </div>
      {confirmingPark && copy.action === 'park' ? (
        <div role="group" aria-label="Confirm parking workspace" style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          flexShrink: 0,
        }}>
          <button
            type="button"
            onClick={() => setConfirmingParkPacketId(null)}
            style={{
              ...confirmationButtonStyle,
              borderColor: 'var(--t-panel-border)',
              backgroundColor: 'transparent',
              color: 'var(--t-text-secondary)',
              fontWeight: 300,
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              setConfirmingParkPacketId(null);
              void runAction('park');
            }}
            style={{
              ...confirmationButtonStyle,
              borderColor: 'var(--t-danger-border)',
              backgroundColor: 'var(--t-danger-soft)',
              color: 'var(--t-danger)',
              fontWeight: 400,
            }}
          >
            Confirm park
          </button>
        </div>
      ) : (
        <button
          type="button"
          aria-busy={busy !== null}
          disabled={disabled}
          onClick={() => {
            if (copy.action === 'park') setConfirmingParkPacketId(packetId);
            else if (copy.action) void runAction(copy.action);
          }}
          style={{
            minHeight: 44,
            paddingTop: 5,
            paddingRight: 10,
            paddingBottom: 5,
            paddingLeft: 10,
            borderRadius: 8,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--t-panel-border)',
            backgroundColor: 'transparent',
            color: 'var(--t-text-secondary)',
            fontSize: 11,
            fontWeight: 300,
            fontFamily: 'var(--font-sans-system)',
            cursor: busy ? 'wait' : disabled ? 'not-allowed' : 'pointer',
            opacity: disabled ? 0.68 : 1,
            flexShrink: 0,
          }}
        >
          {copy.label}
        </button>
      )}
    </div>
  );
}

/** Packet identity is a hard state boundary for latches, receipts, and messages. */
export function WorkspaceParkControl({ packetId }: { packetId: string }) {
  return <WorkspaceParkControlForPacket key={packetId} packetId={packetId} />;
}
