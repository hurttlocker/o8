'use client';

/**
 * ComparisonCard — mission-panel N-card layout for a best-of-n comparison
 * group (#517). Replaces the default single-packet PacketCard rendering
 * when packets share a `comparisonGroupId`.
 *
 * Shows:
 *   - Compact header with group status + model chips
 *   - Per-candidate rows (model label, status, shortstat)
 *   - Inline meta-agent commentary once all candidates complete
 *   - Pick (merges the chosen packet via /api/orchestrator/comparison-pick)
 *   - Merge parts (deferred — shown disabled with tooltip)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { orchestratorRuntimeTone, orchestratorStatusTone } from '@/lib/orchestrator/display';
import type {
  ComparisonCandidateCommentary,
  ComparisonCommentary,
  ComparisonVerdict,
} from '@/lib/orchestrator/comparison-meta';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

interface ComparisonCardProps {
  groupId: string;
  packets: OrchestratorPacket[];
  onPickWinner: (packetId: string) => void | Promise<void>;
}

const JAKARTA = '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif';

function isComparisonPacketComplete(packet: OrchestratorPacket): boolean {
  return packet.status === 'awaiting_review'
    || packet.status === 'released'
    || packet.status === 'archived'
    || packet.status === 'failed'
    || Boolean(packet.review);
}

function modelLabel(packet: OrchestratorPacket): string {
  if (packet.assignedModel && packet.assignedModel.trim()) return packet.assignedModel.trim();
  return orchestratorRuntimeTone(packet.runtime).label;
}

function verdictTone(verdict: ComparisonVerdict): { label: string; color: string; bg: string; border: string } {
  if (verdict === 'recommend') {
    return { label: 'Recommend', color: '#15803d', bg: 'rgba(34, 197, 94, 0.10)', border: 'rgba(34, 197, 94, 0.30)' };
  }
  if (verdict === 'concern') {
    return { label: 'Concern', color: '#b91c1c', bg: 'rgba(239, 68, 68, 0.10)', border: 'rgba(239, 68, 68, 0.30)' };
  }
  return { label: 'Neutral', color: 'var(--t-text-muted)', bg: 'var(--t-divider-subtle)', border: 'var(--t-border)' };
}

export function ComparisonCard({ groupId, packets, onPickWinner }: ComparisonCardProps) {
  const orderedPackets = useMemo(
    () => [...packets].sort((a, b) => (a.comparisonIndex ?? 0) - (b.comparisonIndex ?? 0)),
    [packets],
  );
  const allComplete = useMemo(
    () => orderedPackets.length > 0 && orderedPackets.every(isComparisonPacketComplete),
    [orderedPackets],
  );
  const firstPacket = orderedPackets[0];
  const statusTone = orchestratorStatusTone(firstPacket?.status ?? 'queued');
  const completedCount = orderedPackets.filter(isComparisonPacketComplete).length;

  const [busyPacketId, setBusyPacketId] = useState<string | null>(null);
  const [commentary, setCommentary] = useState<ComparisonCommentary | null>(null);
  const [commentaryLoading, setCommentaryLoading] = useState(false);
  const [commentaryError, setCommentaryError] = useState<string | null>(null);
  const fetchedGroupIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!allComplete) {
      setCommentary(null);
      setCommentaryError(null);
      fetchedGroupIdRef.current = null;
      return;
    }
    if (fetchedGroupIdRef.current === groupId) return;
    fetchedGroupIdRef.current = groupId;

    let cancelled = false;
    setCommentaryLoading(true);
    setCommentaryError(null);

    void (async () => {
      try {
        const response = await fetch('/api/orchestrator/comparison-meta', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ groupId }),
        });
        const payload = await response.json().catch(() => null) as {
          ok?: boolean;
          result?: ComparisonCommentary;
          error?: { message?: string };
        } | null;
        if (cancelled) return;
        if (!response.ok || !payload?.ok || !payload.result) {
          setCommentaryError(payload?.error?.message ?? 'Unable to load commentary.');
          setCommentaryLoading(false);
          return;
        }
        setCommentary(payload.result);
        setCommentaryLoading(false);
      } catch (error) {
        if (cancelled) return;
        setCommentaryError(error instanceof Error ? error.message : 'Unable to load commentary.');
        setCommentaryLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [allComplete, groupId]);

  const handlePick = useCallback(async (packetId: string) => {
    if (busyPacketId) return;
    setBusyPacketId(packetId);
    try {
      await onPickWinner(packetId);
    } finally {
      setBusyPacketId((current) => (current === packetId ? null : current));
    }
  }, [busyPacketId, onPickWinner]);

  if (!firstPacket) return null;

  const candidateByPacketId = new Map<string, ComparisonCandidateCommentary>(
    (commentary?.candidates ?? []).map((candidate) => [candidate.packetId, candidate]),
  );

  return (
    <div
      style={{
        borderRadius: 14,
        background: 'var(--t-panel)',
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-panel-border)',
        flexShrink: 0,
        overflow: 'hidden',
        fontFamily: JAKARTA,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          paddingTop: 8,
          paddingRight: 10,
          paddingBottom: 8,
          paddingLeft: 10,
          borderBottomWidth: 1,
          borderBottomStyle: 'solid',
          borderBottomColor: 'var(--t-divider-subtle)',
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: statusTone.color,
            boxShadow: `0 0 6px ${statusTone.border}`,
            flexShrink: 0,
          }}
        />
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: '-0.01em',
              color: 'var(--t-text)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            Best-of-{orderedPackets.length}: {firstPacket.title.replace(/\s*\([^)]+\)\s*$/, '')}
          </span>
          <span style={{ fontSize: 9, color: 'var(--t-text-faint)' }}>
            {completedCount}/{orderedPackets.length} complete · {firstPacket.referenceLabel}
          </span>
        </div>
        <span
          style={{
            fontSize: 9,
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            color: 'var(--t-accent)',
            background: 'var(--t-accent-soft)',
            paddingTop: 2,
            paddingBottom: 2,
            paddingLeft: 6,
            paddingRight: 6,
            borderRadius: 999,
            flexShrink: 0,
          }}
        >
          compare
        </span>
      </div>

      {/* Meta-agent summary strip */}
      {allComplete ? (
        <div
          style={{
            paddingTop: 8,
            paddingRight: 10,
            paddingBottom: 8,
            paddingLeft: 10,
            fontSize: 10.5,
            lineHeight: 1.45,
            color: 'var(--t-text-secondary)',
            borderBottomWidth: 1,
            borderBottomStyle: 'solid',
            borderBottomColor: 'var(--t-divider-subtle)',
            background: 'var(--t-glass-muted)',
          }}
        >
          {commentaryLoading ? 'Building side-by-side commentary...'
            : commentaryError ? `Commentary unavailable: ${commentaryError}`
            : commentary ? commentary.summary
            : null}
          {commentary && commentary.source === 'fallback-heuristic' ? (
            <span style={{ marginLeft: 6, fontSize: 9, color: 'var(--t-text-faint)' }}>
              (heuristic — set ANTHROPIC_API_KEY for meta-agent rationale)
            </span>
          ) : null}
        </div>
      ) : null}

      {/* Candidate rows */}
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {orderedPackets.map((packet, index) => {
          const rowTone = orchestratorStatusTone(packet.status);
          const candidate = candidateByPacketId.get(packet.id);
          const recommended = commentary?.recommendedPacketId === packet.id;
          const canPick = isComparisonPacketComplete(packet) && packet.status !== 'failed';
          const isBusy = busyPacketId === packet.id;
          const tone = candidate ? verdictTone(candidate.verdict) : null;
          return (
            <div
              key={packet.id}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                paddingTop: 8,
                paddingRight: 10,
                paddingBottom: 8,
                paddingLeft: 10,
                borderTopWidth: index === 0 ? 0 : 1,
                borderTopStyle: 'solid',
                borderTopColor: 'var(--t-divider-subtle)',
                background: recommended ? 'rgba(34, 197, 94, 0.04)' : 'transparent',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: rowTone.color,
                    flexShrink: 0,
                  }}
                />
                <span
                  style={{
                    fontSize: 10.5,
                    fontWeight: 700,
                    letterSpacing: '-0.01em',
                    color: 'var(--t-text)',
                  }}
                >
                  {modelLabel(packet)}
                </span>
                {tone ? (
                  <span
                    style={{
                      fontSize: 9,
                      fontWeight: 700,
                      letterSpacing: '0.06em',
                      textTransform: 'uppercase',
                      color: tone.color,
                      background: tone.bg,
                      borderWidth: 1,
                      borderStyle: 'solid',
                      borderColor: tone.border,
                      paddingTop: 1,
                      paddingBottom: 1,
                      paddingLeft: 6,
                      paddingRight: 6,
                      borderRadius: 999,
                    }}
                  >
                    {tone.label}
                  </span>
                ) : null}
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 9, fontWeight: 600, color: rowTone.color, letterSpacing: '-0.01em' }}>
                  {rowTone.label}
                </span>
              </div>

              {candidate ? (
                <div style={{ fontSize: 10.5, color: 'var(--t-text-secondary)', lineHeight: 1.4 }}>
                  {candidate.oneLineSummary}
                </div>
              ) : null}

              {candidate && candidate.strengths.length > 0 ? (
                <ul style={{ margin: 0, paddingLeft: 14, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {candidate.strengths.map((strength) => (
                    <li key={strength} style={{ fontSize: 10, color: '#15803d', lineHeight: 1.4 }}>
                      {strength}
                    </li>
                  ))}
                </ul>
              ) : null}

              {candidate && candidate.concerns.length > 0 ? (
                <ul style={{ margin: 0, paddingLeft: 14, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {candidate.concerns.map((concern) => (
                    <li key={concern} style={{ fontSize: 10, color: '#b45309', lineHeight: 1.4 }}>
                      {concern}
                    </li>
                  ))}
                </ul>
              ) : null}

              <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
                <button
                  type="button"
                  disabled={!canPick || Boolean(busyPacketId)}
                  onClick={() => { void handlePick(packet.id); }}
                  style={{
                    borderWidth: 0,
                    background: canPick ? 'var(--t-accent)' : 'var(--t-divider)',
                    color: canPick ? '#ffffff' : 'var(--t-text-faint)',
                    paddingTop: 4,
                    paddingRight: 10,
                    paddingBottom: 4,
                    paddingLeft: 10,
                    borderRadius: 8,
                    fontSize: 10.5,
                    fontWeight: 700,
                    letterSpacing: '-0.01em',
                    cursor: canPick && !busyPacketId ? 'pointer' : 'not-allowed',
                    opacity: isBusy ? 0.75 : 1,
                    fontFamily: JAKARTA,
                  }}
                >
                  {isBusy ? 'Picking...' : recommended ? 'Pick (recommended)' : 'Pick'}
                </button>
                <button
                  type="button"
                  disabled
                  title="Merge parts of multiple candidates — coming soon (#517 follow-up)."
                  style={{
                    borderWidth: 1,
                    borderStyle: 'solid',
                    borderColor: 'var(--t-border)',
                    background: 'transparent',
                    color: 'var(--t-text-faint)',
                    paddingTop: 4,
                    paddingRight: 10,
                    paddingBottom: 4,
                    paddingLeft: 10,
                    borderRadius: 8,
                    fontSize: 10.5,
                    fontWeight: 600,
                    letterSpacing: '-0.01em',
                    cursor: 'not-allowed',
                    opacity: 0.6,
                    fontFamily: JAKARTA,
                  }}
                >
                  Merge parts
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
