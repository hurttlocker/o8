'use client';

import React, { useState, useCallback } from 'react';
import type { RecallCard } from '@/lib/cortex/types';

const FACT_TYPE_COLORS: Record<string, string> = {
  decision: '#007aff',
  preference: '#34c759',
  config: '#ff9f0a',
  state: '#8e8e93',
  identity: '#af52de',
  relationship: '#ff2d55',
  temporal: '#5ac8fa',
  kv: '#636366',
  location: '#30d158',
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

  const typeColor = FACT_TYPE_COLORS[fact.factType] ?? '#8e8e93';
  const confidencePercent = Math.round(fact.confidence * 100);
  const confidenceColor = confidencePercent >= 80 ? '#34c759' : confidencePercent >= 50 ? '#ff9f0a' : '#ff3b30';

  const handleReinforce = useCallback(() => {
    onReinforce?.(fact.id);
    setActionState('reinforced');
  }, [fact.id, onReinforce]);

  const handleRetire = useCallback(() => {
    onRetire?.(fact.id);
    setActionState('retired');
  }, [fact.id, onRetire]);

  const handleInject = useCallback(() => {
    onInject?.(`[${fact.factType}] ${fact.text}`);
  }, [fact.factType, fact.text, onInject]);

  if (actionState === 'reinforced') {
    return (
      <div style={{
        padding: '14px 16px',
        background: 'rgba(52, 199, 89, 0.06)',
        borderRadius: 14,
        fontSize: 14,
        color: '#34c759',
        marginBottom: 10,
        fontWeight: 500,
        letterSpacing: '-0.01em',
      }}>
        ✓ Reinforced
      </div>
    );
  }

  if (actionState === 'retired') {
    return (
      <div style={{
        padding: '14px 16px',
        background: 'rgba(142, 142, 147, 0.06)',
        borderRadius: 14,
        fontSize: 14,
        color: '#48484a',
        marginBottom: 10,
        textDecoration: 'line-through',
        letterSpacing: '-0.01em',
      }}>
        {fact.text.slice(0, 60)}
      </div>
    );
  }

  return (
    <div
      onClick={() => !compact && setExpanded((e) => !e)}
      style={{
        background: '#1c1c1e',
        borderRadius: 14,
        padding: compact ? '12px 16px' : '16px',
        marginBottom: 10,
        cursor: compact ? 'default' : 'pointer',
        WebkitTapHighlightColor: 'rgba(255,255,255,0.04)',
      }}
    >
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{
          fontSize: 11, fontWeight: 600, textTransform: 'uppercase',
          letterSpacing: '0.03em', color: typeColor,
          background: `${typeColor}14`, padding: '3px 8px',
          borderRadius: 6, lineHeight: '16px',
        }}>
          {fact.factType}
        </span>
        <span style={{
          fontSize: 11, color: confidenceColor, fontWeight: 600,
          fontVariantNumeric: 'tabular-nums',
        }}>
          {confidencePercent}%
        </span>
        <span style={{
          fontSize: 11, color: '#48484a', marginLeft: 'auto', fontWeight: 400,
        }}>
          {fact.age}
        </span>
      </div>

      {/* Fact body */}
      <div style={{
        fontSize: 15, lineHeight: '21px', color: '#f2f2f7',
        letterSpacing: '-0.01em',
        display: '-webkit-box',
        WebkitLineClamp: expanded ? 99 : (compact ? 2 : 3),
        WebkitBoxOrient: 'vertical', overflow: 'hidden',
      }}>
        {fact.text}
      </div>

      {/* Expanded drawer */}
      {expanded && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 12, color: '#48484a', marginBottom: 12, lineHeight: '16px' }}>
            {fact.source}
            {fact.sourceSection && <span style={{ color: '#3a3a3c' }}> · {fact.sourceSection}</span>}
          </div>
          <div style={{
            height: 6, background: '#2c2c2e', borderRadius: 3,
            marginBottom: 16, overflow: 'hidden',
          }}>
            <div style={{
              height: '100%', width: `${confidencePercent}%`,
              background: confidenceColor, borderRadius: 3,
              transition: 'width 0.4s cubic-bezier(0.32, 0.72, 0, 1)',
            }} />
          </div>
          <div style={{
            display: 'grid',
            gridTemplateColumns: onInject ? '1fr 1fr 1fr' : '1fr 1fr',
            gap: 10,
          }}>
            {onReinforce && (
              <button onClick={(e) => { e.stopPropagation(); handleReinforce(); }} style={{
                padding: '11px 0', borderRadius: 10, border: 'none',
                background: 'rgba(52, 199, 89, 0.1)', color: '#34c759',
                fontSize: 13, fontWeight: 600, cursor: 'pointer',
                letterSpacing: '-0.01em', minHeight: 44,
              }}>
                Reinforce
              </button>
            )}
            {onRetire && (
              <button onClick={(e) => { e.stopPropagation(); handleRetire(); }} style={{
                padding: '11px 0', borderRadius: 10, border: 'none',
                background: 'rgba(142, 142, 147, 0.1)', color: '#8e8e93',
                fontSize: 13, fontWeight: 600, cursor: 'pointer',
                letterSpacing: '-0.01em', minHeight: 44,
              }}>
                Retire
              </button>
            )}
            {onInject && (
              <button onClick={(e) => { e.stopPropagation(); handleInject(); }} style={{
                padding: '11px 0', borderRadius: 10, border: 'none',
                background: 'rgba(0, 122, 255, 0.1)', color: '#007aff',
                fontSize: 13, fontWeight: 600, cursor: 'pointer',
                letterSpacing: '-0.01em', minHeight: 44,
              }}>
                Inject
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
