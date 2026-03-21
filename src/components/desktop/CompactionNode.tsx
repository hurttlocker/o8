'use client';
import React, { useState } from 'react';

interface CompactionNodeProps {
  compactedCount: number;
  summary: string;
}

/**
 * Compaction node — clean glass card showing compressed messages.
 * Cortex brand: glass blue/frost, minimal, Apple-level polish.
 */
export function CompactionNode({ compactedCount, summary }: CompactionNodeProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  // Strip XML tags for display
  const displaySummary = summary
    .replace(/<\/?compacted_context>/g, '')
    .trim();

  return (
    <div style={{
      display: 'flex',
      justifyContent: 'center',
      paddingTop: 16,
      paddingBottom: 16,
    }}>
      <div style={{
        width: '90%',
        maxWidth: 680,
        borderRadius: 14,
        border: '1px solid rgba(59,130,246,0.12)',
        background: 'rgba(59,130,246,0.03)',
        backdropFilter: 'blur(16px)',
        overflow: 'hidden',
      }}>
        {/* Header */}
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingTop: 12,
            paddingBottom: 12,
            paddingLeft: 16,
            paddingRight: 16,
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {/* Compact icon — thin line style */}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(59,130,246,0.5)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 6h16" />
              <path d="M4 12h16" />
              <path d="M4 18h16" />
              <path d="M7 3l5 3 5-3" />
              <path d="M7 21l5-3 5 3" />
            </svg>
            <span style={{
              fontSize: 13,
              fontWeight: 500,
              color: '#94a3b8',
              letterSpacing: '-0.01em',
            }}>
              {compactedCount} messages compressed
            </span>
          </div>

          {/* Chevron */}
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#cbd5e1"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{
              transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
              transition: 'transform 200ms ease',
            }}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>

        {/* Expanded content */}
        {isExpanded && (
          <div style={{
            paddingTop: 0,
            paddingBottom: 16,
            paddingLeft: 16,
            paddingRight: 16,
            borderTop: '1px solid rgba(59,130,246,0.06)',
          }}>
            <div style={{
              marginTop: 12,
              paddingTop: 12,
              paddingBottom: 12,
              paddingLeft: 14,
              paddingRight: 14,
              borderRadius: 10,
              background: 'rgba(59,130,246,0.03)',
              border: '1px solid rgba(59,130,246,0.06)',
            }}>
              <div style={{
                fontSize: 12,
                color: '#64748b',
                whiteSpace: 'pre-wrap',
                lineHeight: 1.7,
                fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
              }}>
                {displaySummary}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
