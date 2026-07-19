'use client';

import { useCallback, useState, type CSSProperties } from 'react';
import {
  CLOSE_UNMERGED_DISPOSITIONS,
  closeUnmergedDispositionLabel,
  type CloseUnmergedDisposition,
} from '@/lib/orchestrator/close-unmerged-shared';

interface PacketCloseUnmergedActionsProps {
  packetId: string;
  onClosed: () => void;
}

const actionStyle: CSSProperties = {
  minHeight: 44,
  borderWidth: 1,
  borderStyle: 'solid',
  borderRadius: 8,
  paddingTop: 7,
  paddingRight: 10,
  paddingBottom: 7,
  paddingLeft: 10,
  fontSize: 11,
  fontWeight: 300,
  letterSpacing: '-0.1px',
  fontFamily: 'var(--font-sans-system)',
  cursor: 'pointer',
};

export function PacketCloseUnmergedActions({ packetId, onClosed }: PacketCloseUnmergedActionsProps) {
  const [confirming, setConfirming] = useState(false);
  const [disposition, setDisposition] = useState<CloseUnmergedDisposition>('adopted_elsewhere');
  const [busyStage, setBusyStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const close = useCallback(async () => {
    setBusyStage('Closing packet…');
    setError(null);
    const stageTimer = window.setTimeout(() => {
      setBusyStage('Preserving work and archiving…');
    }, 3_000);
    try {
      const response = await fetch('/api/orchestrator/discard-packet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packetId, disposition }),
      });
      const payload = await response.json().catch(() => null) as {
        ok?: boolean;
        error?: { message?: string };
      } | null;
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error?.message ?? 'Unable to close this packet.');
      }
      onClosed();
    } catch (closeError) {
      setError(closeError instanceof Error ? closeError.message : 'Unable to close this packet.');
      setBusyStage(null);
    } finally {
      window.clearTimeout(stageTimer);
    }
  }, [disposition, onClosed, packetId]);

  if (!confirming) {
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: 10 }}>
        <button
          type="button"
          onClick={() => setConfirming(true)}
          style={{
            ...actionStyle,
            borderColor: 'var(--t-danger-border)',
            background: 'transparent',
            color: 'var(--t-danger)',
          }}
          onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--t-danger-soft)'; }}
          onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
        >
          Close unmerged…
        </button>
      </div>
    );
  }

  const busy = busyStage !== null;
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        marginTop: 10,
        paddingTop: 10,
        paddingRight: 10,
        paddingBottom: 10,
        paddingLeft: 10,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-danger-border)',
        borderRadius: 10,
        background: 'var(--t-danger-bg, var(--t-bg-card))',
      }}
    >
      <div style={{ fontSize: 11, fontWeight: 300, lineHeight: 1.35, color: 'var(--t-text-secondary)', fontFamily: 'var(--font-sans-system)' }}>
        Close this packet without merging. Its branch is preserved when possible.
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {CLOSE_UNMERGED_DISPOSITIONS.map((option) => {
          const selected = option === disposition;
          return (
            <button
              key={option}
              type="button"
              disabled={busy}
              onClick={() => setDisposition(option)}
              style={{
                ...actionStyle,
                borderColor: selected ? 'var(--t-accent-border)' : 'var(--t-divider-subtle)',
                background: selected ? 'var(--t-accent-soft)' : 'transparent',
                color: selected ? 'var(--t-accent)' : 'var(--t-text-muted)',
                opacity: busy ? 0.6 : 1,
              }}
            >
              {closeUnmergedDispositionLabel(option)}
            </button>
          );
        })}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
        <button
          type="button"
          disabled={busy}
          onClick={() => { void close(); }}
          style={{
            ...actionStyle,
            borderColor: 'var(--t-danger-border)',
            background: 'var(--t-danger-soft)',
            color: 'var(--t-danger)',
            cursor: busy ? 'wait' : 'pointer',
            opacity: busy ? 0.6 : 1,
          }}
        >
          {busyStage ?? 'Confirm close'}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => { setConfirming(false); setError(null); }}
          style={{
            ...actionStyle,
            borderColor: 'var(--t-divider-subtle)',
            background: 'transparent',
            color: 'var(--t-text-muted)',
            cursor: busy ? 'wait' : 'pointer',
            opacity: busy ? 0.6 : 1,
          }}
        >
          Cancel
        </button>
        {error ? <span style={{ fontSize: 10.5, fontWeight: 300, color: 'var(--t-danger)', lineHeight: 1.35 }}>{error}</span> : null}
      </div>
    </div>
  );
}
