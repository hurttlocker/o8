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
  const [actionState, setActionState] = useState<'idle' | 'reinforced' | 'retired'>('idle');

  const typeColor = FACT_TYPE_COLORS[fact.factType] ?? '#5b6475';
  const confidencePercent = Math.round(fact.confidence * 100);
  const confidenceColor = confidencePercent >= 80 ? '#059669' : confidencePercent >= 50 ? '#b45309' : '#dc2626';

  const handleReinforce = useCallback(() => { onReinforce?.(fact.id); setActionState('reinforced'); }, [fact.id, onReinforce]);
  const handleRetire = useCallback(() => { onRetire?.(fact.id); setActionState('retired'); }, [fact.id, onRetire]);
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
        <span style={{ fontSize: 11, color: confidenceColor, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
          {confidencePercent}%
        </span>
        <span style={{ fontSize: 11, color: '#94a3b8', marginLeft: 'auto' }}>{fact.age}</span>
      </div>

      <div style={{
        fontSize: 14, lineHeight: '20px', color: '#111827', letterSpacing: '-0.01em',
        display: '-webkit-box', WebkitLineClamp: expanded ? 99 : (compact ? 2 : 3),
        WebkitBoxOrient: 'vertical', overflow: 'hidden',
      }}>{fact.text}</div>

      {expanded && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 12 }}>
            {fact.source}
            {fact.sourceSection && <span> · {fact.sourceSection}</span>}
          </div>
          <div style={{ height: 4, background: 'rgba(15, 23, 42, 0.06)', borderRadius: 2, marginBottom: 14, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${confidencePercent}%`, background: confidenceColor, borderRadius: 2, transition: 'width 0.4s ease' }} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: onInject ? '1fr 1fr 1fr' : '1fr 1fr', gap: 8 }}>
            {onReinforce && (
              <button onClick={(e) => { e.stopPropagation(); handleReinforce(); }} style={{
                padding: '10px 0', borderRadius: 12, border: '1px solid rgba(5, 150, 105, 0.15)',
                background: 'rgba(5, 150, 105, 0.06)', color: '#059669',
                fontSize: 13, fontWeight: 600, cursor: 'pointer', minHeight: 44,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
              }}>
                <ArrowUp size={14} /> Keep
              </button>
            )}
            {onRetire && (
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
