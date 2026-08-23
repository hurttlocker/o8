'use client';

import { useEffect, useMemo, useState } from 'react';
import { orchestratorStatusTone, packetRuntimeModelDisplayLabel } from '@/lib/orchestrator/display';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

interface ComparisonPickerProps {
  groupId: string;
  packets: OrchestratorPacket[];
  onPickWinner: (packetId: string) => void | Promise<void>;
  onDismiss: () => void;
  /** Open the full N-up diff matrix (the compare O8Panel tab). When omitted, the
   *  inline summary picker stands alone. */
  onCompareDiffs?: () => void;
}

type PacketChangeCountMap = Record<string, number | null | undefined>;

function modelLabel(packet: OrchestratorPacket) {
  return packetRuntimeModelDisplayLabel(packet);
}

async function resolvePacketWorkspacePath(packet: OrchestratorPacket) {
  const laneWorkspacePath = packet.lane?.worktreePath ?? packet.lane?.repoPath ?? null;
  if (laneWorkspacePath) {
    return laneWorkspacePath;
  }
  if (!packet.lane?.laneId) {
    return packet.workspaceTargetPath ?? null;
  }

  const laneResponse = await fetch(`/api/lanes/${encodeURIComponent(packet.lane.laneId)}`, {
    cache: 'no-store',
  });
  const lanePayload = await laneResponse.json().catch(() => null) as {
    lane?: {
      worktreePath?: string | null;
      repoPath?: string | null;
    };
  } | null;
  if (!laneResponse.ok) {
    return packet.workspaceTargetPath ?? null;
  }

  return lanePayload?.lane?.worktreePath ?? lanePayload?.lane?.repoPath ?? packet.workspaceTargetPath ?? null;
}

async function fetchPacketChangeCount(packet: OrchestratorPacket) {
  const workspacePath = await resolvePacketWorkspacePath(packet);
  if (!workspacePath) {
    return null;
  }

  const snapshotResponse = await fetch(
    `/api/review/workspace?workspace=${encodeURIComponent(workspacePath)}`,
    { cache: 'no-store' },
  );
  const snapshotPayload = await snapshotResponse.json().catch(() => null) as {
    changedFiles?: Array<unknown>;
  } | null;
  if (!snapshotResponse.ok) {
    return null;
  }

  return Array.isArray(snapshotPayload?.changedFiles) ? snapshotPayload.changedFiles.length : null;
}

function StatusDot({ color }: { color: string }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" style={{ display: 'block', flexShrink: 0 }}>
      <circle cx="5" cy="5" r="4" fill={color} />
    </svg>
  );
}

export function ComparisonPicker({
  groupId,
  packets,
  onPickWinner,
  onDismiss,
  onCompareDiffs,
}: ComparisonPickerProps) {
  const [busyPacketId, setBusyPacketId] = useState<string | null>(null);
  const [changeCounts, setChangeCounts] = useState<PacketChangeCountMap>({});

  const orderedPackets = useMemo(
    () => [...packets].sort((left, right) => (left.comparisonIndex ?? 0) - (right.comparisonIndex ?? 0)),
    [packets],
  );

  useEffect(() => {
    let cancelled = false;
    const unresolvedPackets = orderedPackets.filter((packet) => (
      changeCounts[packet.id] === undefined
      && (packet.status === 'awaiting_review' || packet.status === 'released')
      && Boolean(packet.lane?.laneId || packet.lane?.repoPath || packet.lane?.worktreePath)
    ));

    if (unresolvedPackets.length === 0) {
      return undefined;
    }

    void Promise.all(
      unresolvedPackets.map(async (packet) => {
        try {
          const fileCount = await fetchPacketChangeCount(packet);
          if (cancelled) return;
          setChangeCounts((current) => (
            current[packet.id] === undefined
              ? { ...current, [packet.id]: fileCount }
              : current
          ));
        } catch {
          if (cancelled) return;
          setChangeCounts((current) => (
            current[packet.id] === undefined
              ? { ...current, [packet.id]: null }
              : current
          ));
        }
      }),
    );

    return () => {
      cancelled = true;
    };
  }, [changeCounts, orderedPackets]);

  return (
    <section
      aria-label={`Comparison group ${groupId}`}
      style={{
        borderRadius: 14,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-panel-border)',
        background: 'var(--t-panel)',
        boxShadow: 'var(--t-glass-shadow)',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        paddingTop: 14,
        paddingRight: 14,
        paddingBottom: 14,
        paddingLeft: 14,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            minWidth: 0,
          }}
        >
          <div
            style={{
              fontSize: 16,
              fontWeight: 700,
              color: 'var(--t-text)',
              letterSpacing: '-0.02em',
            }}
          >
            Compare results
          </div>
          <div
            style={{
              fontSize: 12,
              fontWeight: 500,
              color: 'var(--t-text-secondary)',
            }}
          >
            {orderedPackets.length} candidate{orderedPackets.length === 1 ? '' : 's'} are ready for review.
          </div>
        </div>
        <div
          style={{
            minHeight: 28,
            borderRadius: 999,
            background: 'var(--t-accent-soft)',
            color: 'var(--t-accent)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            paddingTop: 0,
            paddingRight: 10,
            paddingBottom: 0,
            paddingLeft: 10,
            fontSize: 11,
            fontWeight: 700,
            flexShrink: 0,
          }}
        >
          {orderedPackets.length}
        </div>
      </div>

      {onCompareDiffs ? (
        <button
          type="button"
          onClick={onCompareDiffs}
          style={{
            alignSelf: 'flex-start',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            height: 30,
            paddingTop: 0,
            paddingBottom: 0,
            paddingLeft: 12,
            paddingRight: 12,
            borderRadius: 8,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--t-brand-orange, #FF5A1F)',
            background: 'rgba(255, 90, 31, 0.08)',
            color: 'var(--t-brand-orange, #FF5A1F)',
            fontSize: 12,
            fontWeight: 500,
            letterSpacing: '-0.1px',
            cursor: 'pointer',
          }}
        >
          Compare diffs side by side
        </button>
      ) : null}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
          gap: 12,
        }}
      >
        {orderedPackets.map((packet) => {
          const statusTone = orchestratorStatusTone(packet.status);
          const fileCount = changeCounts[packet.id];
          const canPick = packet.status !== 'failed' && packet.status !== 'archived';
          const isBusy = busyPacketId === packet.id;
          const canLoadDiffSummary = (
            (packet.status === 'awaiting_review' || packet.status === 'released')
            && Boolean(packet.lane?.laneId || packet.lane?.repoPath || packet.lane?.worktreePath)
          );

          return (
            <article
              key={packet.id}
              style={{
                minHeight: 184,
                borderRadius: 14,
                borderWidth: 1,
                borderStyle: 'solid',
                borderColor: 'var(--t-divider-subtle)',
                background: 'var(--t-bg-card)',
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
                paddingTop: 12,
                paddingRight: 12,
                paddingBottom: 12,
                paddingLeft: 12,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 10,
                }}
              >
                <div
                  style={{
                    minHeight: 28,
                    borderRadius: 999,
                    borderWidth: 1,
                    borderStyle: 'solid',
                    borderColor: 'var(--t-accent-border)',
                    background: 'var(--t-accent-soft)',
                    color: 'var(--t-accent)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    paddingTop: 0,
                    paddingRight: 10,
                    paddingBottom: 0,
                    paddingLeft: 10,
                    fontSize: 11,
                    fontWeight: 700,
                    flexShrink: 0,
                  }}
                >
                  {modelLabel(packet)}
                </div>
                <div
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    minHeight: 24,
                    color: statusTone.color,
                    fontSize: 11,
                    fontWeight: 700,
                    flexShrink: 0,
                  }}
                >
                  <StatusDot color={statusTone.dot} />
                  <span>{statusTone.label}</span>
                </div>
              </div>

              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                  minWidth: 0,
                }}
              >
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 700,
                    color: 'var(--t-text)',
                    letterSpacing: '-0.01em',
                    lineHeight: 1.35,
                  }}
                >
                  {packet.title}
                </div>
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 500,
                    color: 'var(--t-text-secondary)',
                    lineHeight: 1.4,
                  }}
                >
                  {packet.referenceLabel}
                  {typeof packet.comparisonIndex === 'number' ? ` · Candidate ${packet.comparisonIndex + 1}` : ''}
                </div>
              </div>

              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                  flex: 1,
                }}
              >
                {typeof fileCount === 'number' ? (
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: 'var(--t-text-secondary)',
                    }}
                  >
                    {fileCount} file{fileCount === 1 ? '' : 's'} changed
                  </div>
                ) : canLoadDiffSummary && changeCounts[packet.id] === undefined ? (
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 500,
                      color: 'var(--t-text-muted)',
                    }}
                  >
                    Diff summary loading
                  </div>
                ) : null}

                {/* #1293 — the raw lastEventLabel was noise here: a long prompt
                    blob for one candidate ("IDE-launched Codex run active. ##
                    Project Brief…") and a bare "dispatch_started" for another.
                    The card is a compact entry — model + file count + the
                    "Compare diffs side by side" CTA; the full per-candidate state
                    + diff lives in the compare matrix, so the noisy status line
                    is dropped here. */}
              </div>

              <button
                type="button"
                disabled={!canPick || Boolean(busyPacketId)}
                onClick={() => {
                  setBusyPacketId(packet.id);
                  Promise.resolve(onPickWinner(packet.id))
                    .finally(() => {
                      setBusyPacketId((current) => (current === packet.id ? null : current));
                    });
                }}
                style={{
                  minHeight: 44,
                  borderRadius: 14,
                  borderWidth: 0,
                  background: canPick ? 'var(--t-accent)' : 'var(--t-divider-subtle)',
                  color: canPick ? '#ffffff' : 'var(--t-text-muted)',
                  cursor: canPick && !busyPacketId ? 'pointer' : 'default',
                  fontSize: 13,
                  fontWeight: 700,
                  letterSpacing: '-0.01em',
                  opacity: isBusy ? 0.8 : 1,
                }}
              >
                {isBusy ? 'Picking...' : 'Pick this one'}
              </button>
            </article>
          );
        })}
      </div>

      <button
        type="button"
        onClick={onDismiss}
        style={{
          minHeight: 44,
          alignSelf: 'flex-start',
          borderRadius: 14,
          borderWidth: 0,
          background: 'transparent',
          color: 'var(--t-text-secondary)',
          cursor: 'pointer',
          fontSize: 13,
          fontWeight: 600,
          paddingTop: 0,
          paddingRight: 4,
          paddingBottom: 0,
          paddingLeft: 4,
        }}
      >
        Dismiss
      </button>
    </section>
  );
}
