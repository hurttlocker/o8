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
        padding: '10px 14px',
        background: 'rgba(52, 199, 89, 0.08)',
        borderRadius: 12,
        borderLeft: '3px solid #34c759',
        fontSize: 13,
        color: '#34c759',
        marginBottom: 8,
      }}>
        ✓ Reinforced — decay timer reset
      </div>
    );
  }

  if (actionState === 'retired') {
    return (
      <div style={{
        padding: '10px 14px',
        background: 'rgba(142, 142, 147, 0.08)',
        borderRadius: 12,
        borderLeft: '3px solid #8e8e93',
        fontSize: 13,
        color: '#8e8e93',
        marginBottom: 8,
        textDecoration: 'line-through',
      }}>
        Retired — {fact.text.slice(0, 60)}
      </div>
    );
  }

  return (
    <div
      onClick={() => !compact && setExpanded((e) => !e)}
      style={{
        background: '#1c1c1e',
        borderRadius: 12,
        padding: compact ? '10px 14px' : '14px 16px',
        marginBottom: 8,
        borderLeft: `3px solid ${typeColor}`,
        cursor: compact ? 'default' : 'pointer',
        transition: 'transform 0.15s ease',
      }}
    >
      {/* Header: type badge + confidence + age */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{
          fontSize: 10,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          color: typeColor,
          background: `${typeColor}18`,
          padding: '2px 6px',
          borderRadius: 4,
        }}>
          {fact.factType}
        </span>
        <span style={{
          fontSize: 10,
          color: confidenceColor,
          fontWeight: 500,
        }}>
          {confidencePercent}%
        </span>
        <span style={{ fontSize: 10, color: '#636366', marginLeft: 'auto' }}>
          {fact.age}
        </span>
      </div>

      {/* Fact text */}
      <div style={{
        fontSize: 13,
        lineHeight: '18px',
        color: '#e5e5ea',
        display: '-webkit-box',
        WebkitLineClamp: expanded ? 99 : (compact ? 2 : 3),
        WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
      }}>
        {fact.text}
      </div>

      {/* Expanded details */}
      {expanded && (
        <div style={{ marginTop: 10 }}>
          {/* Source */}
          <div style={{ fontSize: 11, color: '#636366', marginBottom: 8 }}>
            📎 {fact.source}
            {fact.sourceSection && <span> → {fact.sourceSection}</span>}
          </div>

          {/* Confidence bar */}
          <div style={{
            height: 4,
            background: '#2c2c2e',
            borderRadius: 2,
            marginBottom: 10,
            overflow: 'hidden',
          }}>
            <div style={{
              height: '100%',
              width: `${confidencePercent}%`,
              background: confidenceColor,
              borderRadius: 2,
              transition: 'width 0.3s ease',
            }} />
          </div>

          {/* Action buttons */}
          <div style={{ display: 'flex', gap: 8 }}>
            {onReinforce && (
              <button
                onClick={(e) => { e.stopPropagation(); handleReinforce(); }}
                style={{
                  flex: 1,
                  padding: '8px 0',
                  borderRadius: 8,
                  border: 'none',
                  background: 'rgba(52, 199, 89, 0.12)',
                  color: '#34c759',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Reinforce
              </button>
            )}
            {onRetire && (
              <button
                onClick={(e) => { e.stopPropagation(); handleRetire(); }}
                style={{
                  flex: 1,
                  padding: '8px 0',
                  borderRadius: 8,
                  border: 'none',
                  background: 'rgba(142, 142, 147, 0.12)',
                  color: '#8e8e93',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Retire
              </button>
            )}
            {onInject && (
              <button
                onClick={(e) => { e.stopPropagation(); handleInject(); }}
                style={{
                  flex: 1,
                  padding: '8px 0',
                  borderRadius: 8,
                  border: 'none',
                  background: 'rgba(0, 122, 255, 0.12)',
                  color: '#007aff',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Inject ↗
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
