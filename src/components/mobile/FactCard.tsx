'use client';

import React, { useState, useCallback } from 'react';
import { ArrowUp, Trash2, PenLine } from 'lucide-react';
import type { RecallCard } from '@/lib/cortex/types';

const FACT_TYPE_COLORS: Record<string, string> = {
  decision: '#2563eb',
  preference: '#059669',
  config: '#b45309',
  state: '#5b6475',
  identity: '#7c3aed',
  relationship: '#dc2626',
  temporal: '#0891b2',
  kv: '#64748b',
  location: '#059669',
};

interface FactCardProps {
  fact: RecallCard;
  onReinforce?: (id: number) => void;
  onRetire?: (id: number) => void;
  onInject?: (text: string) => void;
  compact?: boolean;
}

export default function FactCard({ fact, onReinforce, onRetire, onInject, compact }: FactCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [showEvidence, setShowEvidence] = useState(false);
  const [actionState, setActionState] = useState<'idle' | 'reinforced' | 'retired'>('idle');

  const typeColor = FACT_TYPE_COLORS[fact.factType] ?? '#5b6475';
  const confidencePercent = Math.max(0, Math.min(100, Math.round(fact.confidence * 100)));
  const confidenceColor = confidencePercent >= 80 ? '#059669' : confidencePercent >= 50 ? '#b45309' : '#dc2626';
  const showExpandedSection = expanded || (compact && Boolean(onInject));
  const evidenceCount = fact.evidenceCount || fact.evidence.length;
  const firstEvidence = fact.evidence[0];
  const sourceLabel = firstEvidence?.sourceFile || fact.sourceTier;

  const handleReinforce = useCallback(() => { onReinforce?.(fact.factId); setActionState('reinforced'); }, [fact.factId, onReinforce]);
  const handleRetire = useCallback(() => { onRetire?.(fact.factId); setActionState('retired'); }, [fact.factId, onRetire]);
  const handleInject = useCallback(() => { onInject?.(`[${fact.factType}] ${fact.text}`); }, [fact.factType, fact.text, onInject]);

  if (actionState === 'reinforced') {
    return (
      <div style={{
        padding: '14px 16px', background: 'rgba(5, 150, 105, 0.06)', borderRadius: 16,
        border: '1px solid rgba(5, 150, 105, 0.12)',
        fontSize: 14, color: '#059669', marginBottom: 10, fontWeight: 500,
      }}>✓ Reinforced</div>
    );
  }

  if (actionState === 'retired') {
    return (
      <div style={{
        padding: '14px 16px', background: 'rgba(15, 23, 42, 0.02)', borderRadius: 16,
        border: '1px solid rgba(15, 23, 42, 0.05)',
        fontSize: 14, color: '#94a3b8', marginBottom: 10, textDecoration: 'line-through',
      }}>{fact.text.slice(0, 60)}</div>
    );
  }

  return (
    <div
      onClick={() => !compact && setExpanded((e) => !e)}
      style={{
        background: 'rgba(255, 255, 255, 0.82)',
        border: '1px solid rgba(15, 23, 42, 0.08)',
        borderRadius: 16,
        padding: compact ? '12px 16px' : '16px',
        marginBottom: 10,
        cursor: compact ? 'default' : 'pointer',
        boxShadow: '0 2px 8px rgba(15, 23, 42, 0.04)',
        backdropFilter: 'blur(12px)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{
          fontSize: 11, fontWeight: 600, textTransform: 'uppercase',
          letterSpacing: '0.03em', color: typeColor,
          background: `${typeColor}14`, padding: '3px 8px', borderRadius: 6,
        }}>{fact.factType}</span>
        <span style={{
          fontSize: 11, fontWeight: 600, color: '#5b6475',
          background: 'rgba(15, 23, 42, 0.05)', padding: '3px 8px', borderRadius: 6,
          textTransform: 'capitalize',
        }}>{fact.sourceTier.replace(/_/g, ' ')}</span>
        {fact.promptEligible && (
          <span style={{
            fontSize: 11, fontWeight: 600, color: '#2563eb',
            background: 'rgba(37, 99, 235, 0.08)', padding: '3px 8px', borderRadius: 6,
          }}>Prompt</span>
        )}
        <span style={{ fontSize: 11, color: confidenceColor, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
          {confidencePercent}%
        </span>
        <span style={{ fontSize: 11, color: '#94a3b8', marginLeft: 'auto' }}>
          {evidenceCount} evidence
        </span>
      </div>

      <div style={{
        fontSize: 14, lineHeight: '20px', color: '#111827', letterSpacing: '-0.01em',
        display: '-webkit-box', WebkitLineClamp: expanded ? 99 : (compact ? 2 : 3),
        WebkitBoxOrient: 'vertical', overflow: 'hidden',
      }}>{fact.text}</div>

      {showExpandedSection && (
        <div style={{ marginTop: 14 }}>
          {!compact && (
            <>
              <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 12, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                <span>{sourceLabel}</span>
                <span>{fact.memoryKind.replace(/_/g, ' ')}</span>
                <span>{fact.retrievalVisibility.replace(/_/g, ' ')}</span>
              </div>
              <div style={{ height: 4, background: 'rgba(15, 23, 42, 0.06)', borderRadius: 2, marginBottom: 14, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${confidencePercent}%`, background: confidenceColor, borderRadius: 2, transition: 'width 0.4s ease' }} />
              </div>
              {fact.reasons.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
                  {fact.reasons.map((reason) => (
                    <span key={reason} style={{
                      fontSize: 11,
                      color: '#5b6475',
                      background: 'rgba(15, 23, 42, 0.04)',
                      borderRadius: 999,
                      padding: '4px 8px',
                    }}>
                      {reason.replace(/_/g, ' ')}
                    </span>
                  ))}
                </div>
              )}
              {evidenceCount > 0 && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowEvidence((value) => !value);
                  }}
                  style={{
                    width: '100%',
                    marginBottom: 12,
                    padding: '10px 12px',
                    borderRadius: 12,
                    border: '1px solid rgba(15, 23, 42, 0.08)',
                    background: 'rgba(15, 23, 42, 0.03)',
                    color: '#334155',
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  {showEvidence ? 'Hide evidence' : `Show evidence (${evidenceCount})`}
                </button>
              )}
              {showEvidence && fact.evidence.length > 0 && (
                <div style={{ display: 'grid', gap: 8, marginBottom: 14 }}>
                  {fact.evidence.map((evidence, index) => (
                    <div key={`${evidence.memoryId}:${index}`} style={{
                      padding: '10px 12px',
                      borderRadius: 12,
                      background: 'rgba(15, 23, 42, 0.03)',
                      border: '1px solid rgba(15, 23, 42, 0.05)',
                    }}>
                      <div style={{ fontSize: 11, color: '#64748b', marginBottom: evidence.quote ? 6 : 0 }}>
                        {evidence.sourceFile}
                        {evidence.sourceLine ? `:${evidence.sourceLine}` : ''}
                      </div>
                      {evidence.quote && (
                        <div style={{ fontSize: 12, lineHeight: '18px', color: '#111827' }}>
                          {evidence.quote}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
          <div style={{
            display: 'grid',
            gridTemplateColumns: compact ? '1fr' : (onInject ? '1fr 1fr 1fr' : '1fr 1fr'),
            gap: 8,
          }}>
            {!compact && onReinforce && (
              <button onClick={(e) => { e.stopPropagation(); handleReinforce(); }} style={{
                padding: '10px 0', borderRadius: 12, border: '1px solid rgba(5, 150, 105, 0.15)',
                background: 'rgba(5, 150, 105, 0.06)', color: '#059669',
                fontSize: 13, fontWeight: 600, cursor: 'pointer', minHeight: 44,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
              }}>
                <ArrowUp size={14} /> Keep
              </button>
            )}
            {!compact && onRetire && (
              <button onClick={(e) => { e.stopPropagation(); handleRetire(); }} style={{
                padding: '10px 0', borderRadius: 12, border: '1px solid rgba(15, 23, 42, 0.08)',
                background: 'rgba(15, 23, 42, 0.03)', color: '#64748b',
                fontSize: 13, fontWeight: 600, cursor: 'pointer', minHeight: 44,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
              }}>
                <Trash2 size={14} /> Retire
              </button>
            )}
            {onInject && (
              <button onClick={(e) => { e.stopPropagation(); handleInject(); }} style={{
                padding: '10px 0', borderRadius: 12, border: '1px solid rgba(37, 99, 235, 0.15)',
                background: 'rgba(37, 99, 235, 0.06)', color: '#2563eb',
                fontSize: 13, fontWeight: 600, cursor: 'pointer', minHeight: 44,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
              }}>
                <PenLine size={14} /> Inject
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
