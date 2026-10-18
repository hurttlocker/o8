'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSharedDesktopWs } from '@/components/desktop/hooks/DesktopWebSocketContext';
import type { RealtimeMutationRecord } from '@/lib/realtime/types';
import type { CorrectableWorker, WorkerCorrectionMode, WorkerCorrectionPayload, WorkerCorrectionReceipt } from '@/lib/orchestrator/worker-correction-types';
import { RamsButton } from '../../settings/RamsButton';

const labels: Record<WorkerCorrectionReceipt['deliveries'][number]['status'], string> = {
  pending: 'Pending', sending: 'Delivery unconfirmed', delivered: 'Accepted by runtime', stopped: 'Stopped',
  unavailable: 'Unavailable', unknown: 'Outcome unknown', held: 'Held',
};

/** Uses the ordinary composer's draft; corrections never create another message editor. */
export function WorkerCorrections({ repoPath, threadId, draft, hasAttachments, onDelivered, working }: {
  repoPath: string; threadId: string; draft: string; hasAttachments: boolean; onDelivered: (draft: string) => void; working: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [workers, setWorkers] = useState<CorrectableWorker[]>([]);
  const [corrections, setCorrections] = useState<WorkerCorrectionReceipt[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [holdMerges, setHoldMerges] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showProgress, setShowProgress] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scope = `${repoPath}\n${threadId}`;
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const requestRef = useRef<{ fingerprint: string; id: string; payload: WorkerCorrectionPayload } | null>(null);
  const latestDraft = useRef(draft); latestDraft.current = draft;
  const [pendingRequest, setPendingRequest] = useState(false);
  const storageKey = `o8-worker-correction:${scope}`;
  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`/api/orchestrator/worker-corrections?${new URLSearchParams({ repoPath, threadId })}`, { cache: 'no-store' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Unable to read worker controls.');
      if (!Array.isArray(body.workers) || !Array.isArray(body.corrections)) throw new Error('Worker controls returned an invalid response. Refresh to try again.');
      if (scopeRef.current !== scope) return;
      setWorkers(body.workers); setCorrections(body.corrections); setError(null);
      setSelected(current => current.filter(id => body.workers.some((worker: CorrectableWorker) => worker.surfaceId === id)));
    } catch (cause) { if (scopeRef.current === scope) setError(cause instanceof Error ? cause.message : 'Unable to read worker controls.'); }
  }, [repoPath, threadId, scope]);
  useSharedDesktopWs(undefined, { onRealtimeEvent: event => {
    const mutation = event.channel === 'mutation' ? (event.data as { mutation?: RealtimeMutationRecord }).mutation : undefined;
    if ((mutation?.action === 'worker-correction' && mutation.surfaceId === threadId) || mutation?.action === 'worker-return') void refresh();
  } });
  useEffect(() => {
    setWorkers([]); setCorrections([]); setSelected([]); setOpen(false); setHoldMerges(false); setBusy(false); setError(null); requestRef.current = null;
    try { requestRef.current = JSON.parse(localStorage.getItem(storageKey) ?? 'null'); } catch { /* No saved delivery. */ }
    setPendingRequest(Boolean(requestRef.current));
  }, [scope, storageKey]);
  useEffect(() => { void refresh(); }, [refresh, working]);
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => { void refresh(); }, 3000);
    return () => clearInterval(timer);
  }, [busy, refresh]);
  useEffect(() => {
    if (!busy) { setShowProgress(false); return; }
    const timer = setTimeout(() => setShowProgress(true), 150);
    return () => clearTimeout(timer);
  }, [busy]);
  const targets = workers.filter(worker => selected.includes(worker.surfaceId));
  const send = async (mode: WorkerCorrectionMode) => {
    if (busy) return;
    const message = mode === 'stop' ? draft.trim() || 'Stop the selected workers.' : draft.trim();
    const payload: WorkerCorrectionPayload = { message, mode, holdMerges, targets: targets.map(({ surfaceId, runId }) => ({ surfaceId, runId })) };
    const fingerprint = JSON.stringify({ scope, payload });
    if (!requestRef.current) requestRef.current = { fingerprint, payload, id: `correction-${crypto.randomUUID()}` };
    try { localStorage.setItem(storageKey, JSON.stringify(requestRef.current)); } catch {
      setError('Unable to save this correction identity. Delivery has not started.'); return;
    }
    setPendingRequest(true);
    setBusy(true); setError(null);
    try {
      const response = await fetch('/api/orchestrator/worker-corrections', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoPath, threadId, id: requestRef.current.id, payload: requestRef.current.payload }) });
      const body = await response.json();
      if (!response.ok) {
        if (body.notAdmitted === true && scopeRef.current === scope) { requestRef.current = null; localStorage.removeItem(storageKey); setPendingRequest(false); }
        throw new Error(body.error || 'Unable to correct workers.');
      }
      if (scopeRef.current !== scope) return;
      const sentDraft = requestRef.current.payload.message;
      const result = body.receipt as WorkerCorrectionReceipt;
      if (result.ruleId) window.dispatchEvent(new CustomEvent('o8:session-rules-changed'));
      if (!result.deliveries.some(delivery => ['pending', 'sending'].includes(delivery.status))) {
        requestRef.current = null; localStorage.removeItem(storageKey); setPendingRequest(false);
      }
      if (latestDraft.current.trim() === sentDraft && result.deliveries.every(delivery => ['delivered', 'stopped'].includes(delivery.status))) onDelivered(latestDraft.current);
      await refresh();
    } catch (cause) { if (scopeRef.current === scope) setError(cause instanceof Error ? cause.message : 'Correction outcome unknown. Inspect workers before retrying.'); }
    finally { if (scopeRef.current === scope) setBusy(false); }
  };
  const unavailableDraft = !draft.trim() || draft.trim().length > 2000 || hasAttachments;
  return <div style={{ fontSize: 11, fontWeight: 300, color: 'var(--t-text-muted)', paddingTop: 4, paddingBottom: 4 }}>
    <RamsButton variant="ghost" onClick={() => { setOpen(!open); if (!open) void refresh(); }} aria-expanded={open} aria-controls={`worker-corrections-${threadId}`}>
      {corrections.length ? 'Worker corrections' : 'Correct workers'}
    </RamsButton>
    {open ? <div id={`worker-corrections-${threadId}`} style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 8, paddingBottom: 8 }}>
      <span>Use the message in your composer. Choose the workers it applies to.</span>
      {workers.map(worker => <label key={worker.surfaceId} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input type="checkbox" checked={selected.includes(worker.surfaceId)} disabled={busy} onChange={event => setSelected(current => event.target.checked ? [...current, worker.surfaceId] : current.filter(id => id !== worker.surfaceId))} />
        {worker.taskName} · {worker.runtime} · {worker.running ? 'Working' : 'Idle'}
      </label>)}
      {!workers.length ? <span>No active workers with supported correction controls. Archived or stopped workers remain unchanged.</span> : null}
      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}><input type="checkbox" checked={holdMerges} disabled={busy} onChange={event => setHoldMerges(event.target.checked)} />
        Block o8 merges for this chat until I remove the session rule
      </label>
      {pendingRequest ? <span>A saved correction needs a delivery receipt. Checking reuses that request and never resends an admitted correction.</span> : null}
      {hasAttachments ? <span>Worker corrections currently accept text. Send attachments through the worker’s regular composer.</span> : null}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <RamsButton variant="ghost" busy={busy} disabled={!pendingRequest && (unavailableDraft || (!targets.length && !holdMerges))} onClick={() => void send(targets.some(worker => worker.running) ? 'pause-and-send' : 'send')}>
          {pendingRequest ? 'Check pending correction' : targets.some(worker => worker.running) ? 'Pause and correct selected' : targets.length ? 'Send correction' : 'Save merge restriction'}
        </RamsButton>
        <RamsButton variant="ghost" disabled={busy || pendingRequest || !targets.length} onClick={() => void send('stop')}>Stop selected</RamsButton>
      </div>
      {showProgress ? <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <progress aria-label="Delivering correction" style={{ width: 64, height: 4 }} />
        {corrections.find(item => item.id === requestRef.current?.id)?.deliveries.filter(item => !['pending', 'sending'].includes(item.status)).length ?? 0} of {requestRef.current?.payload.targets.length ?? 0} worker receipts received
      </div> : null}
      {error ? <span role="alert" style={{ color: 'var(--t-error)' }}>{error}</span> : null}
      {corrections.slice(0, 5).map(correction => <div key={correction.id} style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 4 }}>
        <span>{correction.payload.message}</span>
        {correction.ruleId ? <span>Merge restriction saved. Manage it in this chat’s session rules.</span> : null}
        {correction.deliveries.map(delivery => <span key={delivery.surfaceId} title={delivery.note}>
          {workers.find(worker => worker.surfaceId === delivery.surfaceId)?.taskName ?? delivery.surfaceId}: {labels[delivery.status]}. {delivery.note}
        </span>)}
      </div>)}
    </div> : null}
  </div>;
}
