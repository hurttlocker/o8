'use client';
import React, { useState } from 'react';

interface CompactionNodeProps {
  compactedCount: number;
  summary: string;
}

/**
 * Glass-morphic compaction node — shows when older messages
 * have been compressed into a dense context summary.
 * Collapsible: click to expand and see retained context.
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
      paddingTop: 12,
      paddingBottom: 12,
    }}>
      <div style={{
        width: '85%',
        maxWidth: 640,
        borderRadius: 12,
        border: '1px solid rgba(168,85,247,0.2)',
        background: 'linear-gradient(135deg, rgba(168,85,247,0.06) 0%, rgba(139,92,246,0.03) 100%)',
        backdropFilter: 'blur(12px)',
        overflow: 'hidden',
        transition: 'all 200ms ease',
      }}>
        {/* Header — clickable */}
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingTop: 10,
            paddingBottom: 10,
            paddingLeft: 14,
            paddingRight: 14,
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            transition: 'background 150ms',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(168,85,247,0.08)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {/* Brain icon */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 28,
              height: 28,
              borderRadius: 7,
              background: 'rgba(168,85,247,0.15)',
            }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(192,132,252,0.9)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2a4 4 0 0 1 4 4v1a4 4 0 0 1-2 3.46V12a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-1.54A4 4 0 0 1 8 7V6a4 4 0 0 1 4-4z" />
                <path d="M8 7a4 4 0 0 0-4 4v1a4 4 0 0 0 4 4" />
                <path d="M16 7a4 4 0 0 1 4 4v1a4 4 0 0 1-4 4" />
                <path d="M12 14v8" />
                <path d="M8 18h8" />
              </svg>
            </div>
            <span style={{
              fontSize: 12,
              fontWeight: 600,
              color: '#d4d4d8',
              letterSpacing: '0.01em',
            }}>
              {compactedCount} messages compressed
            </span>
            {/* Sparkle */}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="rgba(168,85,247,0.5)" stroke="none">
              <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" />
            </svg>
          </div>

          {/* Chevron */}
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#71717a"
            strokeWidth="2"
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

        {/* Expanded summary */}
        {isExpanded && (
          <div style={{
            paddingTop: 12,
            paddingBottom: 14,
            paddingLeft: 14,
            paddingRight: 14,
            borderTop: '1px solid rgba(168,85,247,0.12)',
            background: 'rgba(0,0,0,0.15)',
          }}>
            <div style={{
              fontSize: 10,
              fontWeight: 700,
              color: 'rgba(192,132,252,0.7)',
              textTransform: 'uppercase' as const,
              letterSpacing: '0.08em',
              marginBottom: 8,
            }}>
              Retained Context
            </div>
            <div style={{
              fontSize: 12,
              color: '#d4d4d8',
              whiteSpace: 'pre-wrap',
              lineHeight: 1.6,
              fontFamily: 'ui-monospace, SFMono-Regular, monospace',
            }}>
              {displaySummary}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
