'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { claimFirstMergeFeedback, finishFirstMergeFeedback, parseFirstMergeFeedbackSnapshot,
  readFirstMergeFeedbackSnapshot, subscribeFirstMergeFeedback } from '@/lib/feedback/first-merge-feedback-store';
import { submitFeedback } from '@/lib/feedback/minimal-feedback-client';
import { useReportDataSharing } from '@/lib/feedback/report-data-sharing-client';
import { REPORT_DATA_SHARING_OFF_ERROR } from '@/lib/feedback/data-sharing';
import { RamsButton } from '@/components/desktop/settings/shared';

function mergedAt(packet: OrchestratorPacket): number | null {
  if (packet.releaseState !== 'released' || !packet.releaseStatePayload?.mergeCommit?.trim()) return null;
  const at = Date.parse(packet.releaseStatePayload.releasedAt ?? '');
  return Number.isFinite(at) ? at : null;
}

/** An inline, optional question on the earliest known merged card, never a launch modal. */
export function FirstMergeFeedback({ packet, allPackets, onDone }: {
  packet: OrchestratorPacket; allPackets: OrchestratorPacket[]; onDone: () => void;
}) {
  const candidate = allPackets.filter(p => !p.comparisonGroupId && mergedAt(p) !== null)
    .sort((a, b) => mergedAt(a)! - mergedAt(b)! || a.id.localeCompare(b.id))[0]?.id ?? null;
  const snapshot = useSyncExternalStore(subscribeFirstMergeFeedback, readFirstMergeFeedbackSnapshot, () => null);
  const record = parseFirstMergeFeedbackSnapshot(snapshot);
  useEffect(() => { if (candidate) claimFirstMergeFeedback(candidate); }, [candidate]);
  if (mergedAt(packet) === null || record?.packetId !== packet.id || record.done) return null;
  return <FirstMergeFeedbackForm packetId={packet.id} onDone={onDone} />;
}

function FirstMergeFeedbackForm({ packetId, onDone }: { packetId: string; onDone: () => void }) {
  const sharing = useReportDataSharing();
  const form = useRef<HTMLFormElement>(null);
  const inFlight = useRef(false);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const finish = () => {
    const restoreFocus = Boolean(form.current?.contains(document.activeElement));
    finishFirstMergeFeedback(packetId);
    if (restoreFocus) onDone();
  };
  const send = async () => {
    if (inFlight.current || !sharing.enabled || !message.trim()) return;
    inFlight.current = true; setSending(true); setError(null);
    try {
      const result = await submitFeedback({ message: message.trim(), includeMetadata: false });
      if (result.ok) finish();
      else {
        if (result.code === REPORT_DATA_SHARING_OFF_ERROR) sharing.markDisabled();
        setError(result.error);
      }
    } finally { inFlight.current = false; setSending(false); }
  };
  return <form ref={form} onSubmit={event => { event.preventDefault(); void send(); }}
    style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, paddingTop: 8, paddingRight: 10, paddingBottom: 8, paddingLeft: 10, borderTop: '1px solid var(--t-divider-subtle)', fontSize: 11, fontWeight: 300, color: 'var(--t-text)' }}>
    <span style={{ width: '100%' }}>First merge done. Anything that nearly stopped you?</span>
    <input aria-label="First merge feedback" value={message} onChange={event => setMessage(event.target.value)} maxLength={4000} disabled={sending}
      style={{ flex: '1 1 160px', minWidth: 0, padding: 6, borderRadius: 6, border: '1px solid var(--t-input-border)', background: 'var(--t-input-bg)', color: 'var(--t-text)', fontFamily: 'var(--font-sans-system)', fontSize: 12, fontWeight: 300 }} />
    <RamsButton type="submit" busy={sending} disabled={!sharing.enabled || !message.trim()}>{sending ? 'Sending feedback…' : 'Send feedback'}</RamsButton>
    <RamsButton variant="ghost" disabled={sending} onClick={finish}>Dismiss</RamsButton>
    <span style={{ width: '100%', color: 'var(--t-text-muted)', lineHeight: 1.4 }}>Only your message is attached. Uses your crash &amp; error reports setting.</span>
    {sharing.status !== 'checking' && !sharing.enabled ? <span role="status">Feedback is disabled while crash &amp; error reports are off.</span> : null}
    {error || sharing.error ? <span role="alert">{error || sharing.error}</span> : null}
  </form>;
}
