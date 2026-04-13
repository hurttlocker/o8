'use client';

import { formatConflictDate } from './conflict-helpers';
import type { ConflictPair } from './types';

interface ConflictsSectionProps {
  conflicts: ConflictPair[];
  conflictsLoading: boolean;
  conflictsChecked: boolean;
  conflictError: string;
  conflictToast: string;
  resolving: number | null;
  onCheckConflicts: () => void;
  onResolveConflict: (keepId: number, dropId: number) => void;
}

export function ConflictsSection({
  conflicts,
  conflictsLoading,
  conflictsChecked,
  conflictError,
  conflictToast,
  resolving,
  onCheckConflicts,
  onResolveConflict,
}: ConflictsSectionProps) {
  return (
    <div style={{ marginBottom: 32, position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text, #0f172a)' }}>
            Conflicts
          </div>
          {conflictsChecked && (
            <span style={{
              fontSize: 11,
              fontWeight: 700,
              paddingTop: 2,
              paddingBottom: 2,
              paddingLeft: 8,
              paddingRight: 8,
              borderRadius: 999,
              background: conflicts.length > 0 ? 'rgba(239,68,68,0.08)' : 'rgba(34,197,94,0.08)',
              color: conflicts.length > 0 ? '#dc2626' : '#16a34a',
            }}>
              {conflicts.length}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onCheckConflicts}
          disabled={conflictsLoading || resolving !== null}
          style={{
            paddingTop: 8,
            paddingBottom: 8,
            paddingLeft: 14,
            paddingRight: 14,
            borderRadius: 10,
            border: '1px solid var(--t-border, #e2e8f0)',
            background: 'var(--t-bg, white)',
            color: 'var(--t-text, #0f172a)',
            fontSize: 12,
            fontWeight: 600,
            cursor: conflictsLoading || resolving !== null ? 'wait' : 'pointer',
            opacity: conflictsLoading || resolving !== null ? 0.7 : 1,
          }}
        >
          {conflictsLoading ? 'Checking…' : 'Check Conflicts'}
        </button>
      </div>
      <p style={{ fontSize: 11, color: 'var(--t-text-muted, #94a3b8)', margin: '0 0 12px', lineHeight: '1.4' }}>
        Review contradictory facts and decide which version Cortex should keep.
      </p>

      {conflictError && (
        <div style={{
          fontSize: 12,
          color: '#dc2626',
          marginBottom: 12,
          paddingTop: 10,
          paddingBottom: 10,
          paddingLeft: 12,
          paddingRight: 12,
          borderRadius: 10,
          border: '1px solid rgba(239,68,68,0.12)',
          background: 'rgba(239,68,68,0.04)',
        }}>
          {conflictError}
        </div>
      )}

      {!conflictsChecked && !conflictsLoading && (
        <div style={{
          paddingTop: 14,
          paddingBottom: 14,
          paddingLeft: 16,
          paddingRight: 16,
          borderRadius: 12,
          border: '1px dashed var(--t-border, #e2e8f0)',
          background: 'rgba(148,163,184,0.03)',
          color: 'var(--t-text-muted, #94a3b8)',
          fontSize: 12,
        }}>
          Run a fresh scan to inspect up to 20 contradictory fact pairs.
        </div>
      )}

      {conflictsLoading && (
        <div style={{
          paddingTop: 16,
          paddingBottom: 16,
          paddingLeft: 16,
          paddingRight: 16,
          borderRadius: 12,
          border: '1px solid var(--t-border, #e2e8f0)',
          background: 'var(--t-bg-card, #f8fafc)',
          color: 'var(--t-text-muted, #94a3b8)',
          fontSize: 12,
        }}>
          Scanning Cortex for contradictory facts…
        </div>
      )}

      {conflictsChecked && !conflictsLoading && conflicts.length === 0 && (
        <div style={{ textAlign: 'center', padding: '20px 0', color: 'var(--t-text-muted)' }}>
          <span style={{ fontSize: 13 }}>No conflicts found — your knowledge base is consistent ✓</span>
        </div>
      )}

      {conflictsChecked && !conflictsLoading && conflicts.length > 0 && (
        <div>
          {conflicts.map((pair) => {
            const pairKey = `${pair.factA.id}-${pair.factB.id}`;
            const pairResolving = resolving === pair.factA.id || resolving === pair.factB.id;
            const subject = pair.factA.subject || pair.factB.subject;
            const predicate = pair.factA.predicate || pair.factB.predicate;

            return (
              <div
                key={pairKey}
                style={{
                  padding: 16,
                  borderRadius: 12,
                  border: '1px solid var(--t-border, #e2e8f0)',
                  background: 'var(--t-bg-card, #f8fafc)',
                  marginBottom: 12,
                  opacity: pairResolving ? 0 : 1,
                  transform: pairResolving ? 'translateY(-8px) scale(0.98)' : 'translateY(0) scale(1)',
                  transition: 'opacity 180ms ease, transform 180ms ease',
                  pointerEvents: pairResolving ? 'none' : 'auto',
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text)', marginBottom: 12 }}>
                  <span style={{ color: '#2563eb' }}>{subject}</span>
                  <span style={{ color: 'var(--t-text-muted)', margin: '0 6px' }}>→</span>
                  <span>{predicate}</span>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  {[
                    { fact: pair.factA, other: pair.factB, side: 'A' },
                    { fact: pair.factB, other: pair.factA, side: 'B' },
                  ].map(({ fact, other, side }) => {
                    const keepBusy = resolving === fact.id;
                    const otherBusy = resolving === other.id;

                    return (
                      <div
                        key={`${pairKey}-${side}`}
                        style={{
                          padding: 12,
                          borderRadius: 10,
                          border: '1px solid var(--t-border, #e2e8f0)',
                          background: 'var(--t-bg, white)',
                        }}
                      >
                        <div style={{
                          fontSize: 10,
                          fontWeight: 700,
                          letterSpacing: '0.04em',
                          textTransform: 'uppercase',
                          color: 'var(--t-text-muted, #94a3b8)',
                          marginBottom: 8,
                        }}>
                          Fact {side}
                        </div>
                        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--t-text, #0f172a)', marginBottom: 8, lineHeight: '1.45' }}>
                          &quot;{fact.object}&quot;
                        </div>
                        <div style={{ fontSize: 10, color: 'var(--t-text-muted, #94a3b8)', display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                          <span>Confidence: {(fact.confidence * 100).toFixed(0)}%</span>
                          <span>·</span>
                          <span>Source: {fact.source}</span>
                        </div>
                        <div style={{ fontSize: 10, color: 'var(--t-text-muted, #94a3b8)', display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
                          <span>Last seen: {formatConflictDate(fact.lastSeen)}</span>
                          <span>·</span>
                          <span>ID: {fact.id}</span>
                          {fact.factType ? (
                            <>
                              <span>·</span>
                              <span>Type: {fact.factType}</span>
                            </>
                          ) : null}
                        </div>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button
                            type="button"
                            onClick={() => onResolveConflict(fact.id, other.id)}
                            disabled={resolving !== null}
                            style={{
                              flex: 1,
                              padding: '6px 0',
                              borderRadius: 8,
                              border: '1px solid rgba(34,197,94,0.3)',
                              background: 'rgba(34,197,94,0.06)',
                              color: '#16a34a',
                              fontSize: 11,
                              fontWeight: 600,
                              cursor: resolving !== null ? 'wait' : 'pointer',
                              opacity: resolving !== null ? 0.7 : 1,
                            }}
                          >
                            {keepBusy ? 'Resolving…' : 'Keep this'}
                          </button>
                          <button
                            type="button"
                            onClick={() => onResolveConflict(other.id, fact.id)}
                            disabled={resolving !== null}
                            style={{
                              padding: '6px 10px',
                              borderRadius: 8,
                              border: '1px solid rgba(239,68,68,0.2)',
                              background: 'transparent',
                              color: '#dc2626',
                              fontSize: 11,
                              fontWeight: 500,
                              cursor: resolving !== null ? 'wait' : 'pointer',
                              opacity: resolving !== null ? 0.7 : 1,
                            }}
                          >
                            {otherBusy ? 'Keeping other…' : 'Drop'}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {conflictToast && (
        <div style={{
          position: 'fixed',
          right: 24,
          bottom: 24,
          paddingTop: 10,
          paddingBottom: 10,
          paddingLeft: 14,
          paddingRight: 14,
          borderRadius: 12,
          border: '1px solid rgba(34,197,94,0.18)',
          background: 'rgba(15,23,42,0.94)',
          color: '#dcfce7',
          fontSize: 12,
          fontWeight: 600,
          boxShadow: '0 18px 40px rgba(15,23,42,0.18)',
          zIndex: 40,
        }}>
          {conflictToast}
        </div>
      )}
    </div>
  );
}
