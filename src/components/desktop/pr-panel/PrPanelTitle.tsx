'use client';

import { memo, useMemo } from 'react';
import { ChevronDown, ChevronRight } from '../lucide-shims';
import { renderInline } from '../LLMMarkdown';

interface PrPanelTitleProps {
  title: string;
  prNumber: number;
  body: string;
  expanded: boolean;
  onToggle: () => void;
}

const SUMMARY_BULLETS_LIMIT = 3;

function extractBullets(body: string): string[] {
  if (!body) return [];
  const lines = body.split('\n').map((line) => line.trim()).filter(Boolean);
  const bullets = lines
    .filter((line) => /^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, ''));
  if (bullets.length > 0) return bullets;
  // Fallback: first few non-empty lines (skip headings)
  return lines.filter((line) => !line.startsWith('#')).slice(0, 5);
}

export const PrPanelTitle = memo(function PrPanelTitle({
  title,
  prNumber,
  body,
  expanded,
  onToggle,
}: PrPanelTitleProps) {
  const bullets = useMemo(() => extractBullets(body), [body]);
  const visibleBullets = expanded ? bullets : bullets.slice(0, SUMMARY_BULLETS_LIMIT);
  const hasMore = bullets.length > SUMMARY_BULLETS_LIMIT;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        paddingTop: 12,
        paddingBottom: 12,
        paddingLeft: 14,
        paddingRight: 14,
        borderBottom: '1px solid var(--t-divider-subtle)',
      }}
    >
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--t-text)', letterSpacing: '-0.01em', lineHeight: 1.35 }}>
        {title}
        <span style={{ color: 'var(--t-text-muted)', fontWeight: 400, marginLeft: 6 }}>#{prNumber}</span>
      </div>

      {bullets.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div
            style={{
              fontSize: 10,
              fontWeight: 600,
              color: 'var(--t-text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
            }}
          >
            Summary
          </div>
          <ul
            style={{
              listStyle: 'disc',
              paddingLeft: 18,
              margin: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 3,
            }}
          >
            {visibleBullets.map((bullet, index) => (
              <li
                key={index}
                style={{
                  fontSize: 12,
                  color: 'var(--t-text-secondary, var(--t-text-muted))',
                  lineHeight: 1.5,
                }}
              >
                {renderInline(bullet)}
              </li>
            ))}
          </ul>
          {hasMore ? (
            <button
              type="button"
              onClick={onToggle}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                marginTop: 2,
                background: 'transparent',
                border: 'none',
                padding: 0,
                color: 'var(--t-accent)',
                fontSize: 11,
                fontWeight: 600,
                cursor: 'pointer',
                alignSelf: 'flex-start',
              }}
            >
              {expanded ? (
                <>
                  <ChevronDown size={11} strokeWidth={2} />
                  Show less
                </>
              ) : (
                <>
                  <ChevronRight size={11} strokeWidth={2} />
                  Show more
                </>
              )}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});
