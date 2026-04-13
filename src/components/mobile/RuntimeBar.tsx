import { memo, useMemo } from 'react';
import type { RuntimeBarProps } from './types';
import { sessionStatusSummary } from './utils';
import {
  MOBILE_MONO_FONT,
  MOBILE_SYSTEM_FONT,
  neomorphicButtonStyle,
  neomorphicSurfaceStyle,
} from './neomorph';

const REPO_DISPLAY: Record<string, string> = {
  'cortex-ide': 'o8',
  'cortex': 'Cortex',
  'spear-production': 'Spear',
  'mybeautifulwife': 'Eyes Web',
  'parasite-network': 'Parasite',
};

function prettyRepo(raw?: string | null): string {
  if (!raw) return '';
  const slug = raw.replace(/^.*\//, '').replace(/\.git$/, '');
  return REPO_DISPLAY[slug] || slug;
}

export const RuntimeBar = memo(function RuntimeBar({
  snapshot,
  selectedSession,
  selectedReviewPacket,
  isOwnedCodexSession,
  compactLine,
  reviewFiles,
  onOpenDiff,
}: RuntimeBarProps & {
  reviewFiles?: { additions?: number | null; deletions?: number | null }[];
  onOpenDiff?: () => void;
}) {
  const status = sessionStatusSummary(selectedSession, selectedReviewPacket, isOwnedCodexSession);
  const branch = compactLine(
    snapshot.review?.branch ?? selectedSession?.branch ?? 'main',
    'main',
    18,
  );
  const repo = useMemo(() => {
    const slug = snapshot.review?.repoSlug
      ?? selectedReviewPacket?.repoSlug
      ?? selectedSession?.workspace
      ?? '';
    return prettyRepo(slug);
  }, [snapshot.review, selectedReviewPacket, selectedSession]);

  const totalAdd = reviewFiles?.reduce((sum, file) => sum + (file.additions ?? 0), 0) ?? 0;
  const totalDel = reviewFiles?.reduce((sum, file) => sum + (file.deletions ?? 0), 0) ?? 0;
  const hasDiff = totalAdd > 0 || totalDel > 0;
  const tone = status.tone === 'critical'
    ? 'red'
    : status.tone === 'high' || status.tone === 'watch'
      ? 'orange'
      : 'green';
  const toneColor = tone === 'red' ? '#ef4444' : tone === 'orange' ? '#f59e0b' : '#16a34a';

  return (
    <div
      style={{
        paddingTop: 8,
        paddingRight: 14,
        paddingBottom: 12,
        paddingLeft: 14,
      }}
    >
      <div
        style={neomorphicSurfaceStyle(tone, {
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          paddingTop: 10,
          paddingRight: 12,
          paddingBottom: 10,
          paddingLeft: 12,
          borderRadius: 20,
        })}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            backgroundColor: toneColor,
            boxShadow: `0 0 10px ${toneColor}33`,
            flexShrink: 0,
          }}
        />

        {repo ? (
          <span
            style={{
              ...neomorphicSurfaceStyle('blue', {
                maxWidth: 110,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                paddingTop: 6,
                paddingRight: 10,
                paddingBottom: 6,
                paddingLeft: 10,
                borderRadius: 14,
              }),
              fontSize: 11,
              fontWeight: 700,
              color: '#1d4ed8',
              fontFamily: MOBILE_SYSTEM_FONT,
              letterSpacing: '-0.01em',
              flexShrink: 0,
            }}
          >
            {repo}
          </span>
        ) : null}

        <span
          style={{
            ...neomorphicSurfaceStyle('slate', {
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              minWidth: 0,
              paddingTop: 6,
              paddingRight: 10,
              paddingBottom: 6,
              paddingLeft: 10,
              borderRadius: 14,
            }),
            fontSize: 11,
            fontWeight: 600,
            color: '#475569',
            fontFamily: MOBILE_MONO_FONT,
            letterSpacing: '-0.01em',
            flexShrink: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#64748b"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ flexShrink: 0 }}
          >
            <line x1="6" y1="3" x2="6" y2="15" />
            <circle cx="18" cy="6" r="3" />
            <circle cx="6" cy="18" r="3" />
            <path d="M18 9a9 9 0 0 1-9 9" />
          </svg>
          {branch}
        </span>

        <span style={{ flex: 1 }} />

        {hasDiff ? (
          <button
            type="button"
            onClick={onOpenDiff}
            style={{
              ...neomorphicButtonStyle('slate', false, {
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                paddingTop: 6,
                paddingRight: 10,
                paddingBottom: 6,
                paddingLeft: 10,
                cursor: 'pointer',
              }),
              fontFamily: MOBILE_MONO_FONT,
            }}
          >
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: '#16a34a',
                letterSpacing: '-0.01em',
              }}
            >
              {`+${totalAdd}`}
            </span>
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: '#ef4444',
                letterSpacing: '-0.01em',
              }}
            >
              {`-${totalDel}`}
            </span>
          </button>
        ) : null}

        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: toneColor,
            fontFamily: MOBILE_MONO_FONT,
            letterSpacing: '-0.01em',
            flexShrink: 0,
          }}
        >
          {status.headline}
        </span>
      </div>
    </div>
  );
});
