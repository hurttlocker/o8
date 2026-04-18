'use client';

import type { CSSProperties } from 'react';

interface ThinkingStripProps {
  thinking: string;
  live?: boolean;
  style?: CSSProperties;
}

function approxTokens(value: string): number {
  return Math.max(1, Math.ceil(value.trim().length / 4));
}

function formatTokenCount(value: number): string {
  if (value >= 10_000) return `${Math.round(value / 1000)}k tokens`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k tokens`;
  return `${value} tokens`;
}

function summarizeThinking(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function ThinkingStrip({ thinking, live = false, style }: ThinkingStripProps) {
  const summary = summarizeThinking(thinking);
  if (!summary) return null;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        minWidth: 0,
        maxWidth: '100%',
        padding: '7px 10px',
        borderRadius: 10,
        border: live ? '1px solid rgba(37, 99, 235, 0.18)' : '1px solid var(--t-panel-border)',
        background: live
          ? 'linear-gradient(180deg, rgba(37, 99, 235, 0.06), rgba(37, 99, 235, 0.02))'
          : 'var(--t-bg-card, rgba(148, 163, 184, 0.06))',
        color: 'var(--t-text-muted)',
        fontSize: 11,
        lineHeight: 1.35,
        fontFamily: '"SFMono-Regular", ui-monospace, "Cascadia Code", "Source Code Pro", Menlo, monospace',
        letterSpacing: '-0.01em',
        ...style,
      }}
    >
      <span
        style={{
          flexShrink: 0,
          color: live ? '#2563eb' : 'var(--t-text-secondary)',
          whiteSpace: 'nowrap',
        }}
      >
        {`(THINKING · ${formatTokenCount(approxTokens(summary))})`}
      </span>
      <span
        style={{
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {`— ${summary}`}
      </span>
    </div>
  );
}
