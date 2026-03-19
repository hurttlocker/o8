import { memo, useMemo } from 'react';
import type { RuntimeBarProps } from './types';
import { sessionStatusSummary } from './utils';

/* ── repo name prettifier ────────────────────────────── */
const REPO_DISPLAY: Record<string, string> = {
  'cortex-ide': 'Cortex IDE',
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

  const totalAdd = reviewFiles?.reduce((s, f) => s + (f.additions ?? 0), 0) ?? 0;
  const totalDel = reviewFiles?.reduce((s, f) => s + (f.deletions ?? 0), 0) ?? 0;
  const hasDiff = totalAdd > 0 || totalDel > 0;

  const toneColor = status.tone === 'critical' ? '#ff3b30'
    : status.tone === 'high' ? '#ff9f0a'
    : status.tone === 'watch' ? '#ffcc00'
    : '#34c759';

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      padding: '6px 14px',
      paddingBottom: 'calc(6px + env(safe-area-inset-bottom, 0px))',
    }}>
      {/* Status dot */}
      <span style={{
        width: 6, height: 6, borderRadius: '50%',
        background: toneColor,
        flexShrink: 0,
      }} />

      {/* Repo pill */}
      {repo && (
        <span style={{
          padding: '3px 8px',
          borderRadius: 6,
          background: 'rgba(0,122,255,0.06)',
          border: '1px solid rgba(0,122,255,0.1)',
          fontSize: 11, fontWeight: 600,
          color: '#007aff',
          fontFamily: '-apple-system, system-ui, sans-serif',
          flexShrink: 0,
          maxWidth: 100,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {repo}
        </span>
      )}

      {/* Branch pill */}
      <span style={{
        display: 'flex', alignItems: 'center', gap: 3,
        padding: '3px 8px',
        borderRadius: 6,
        background: 'rgba(0,0,0,0.03)',
        border: '1px solid rgba(0,0,0,0.06)',
        fontSize: 11, fontWeight: 500,
        color: '#64748b',
        fontFamily: '"SF Mono", ui-monospace, monospace',
        flexShrink: 1, minWidth: 0,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none"
          stroke="#8e8e93" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          style={{ flexShrink: 0 }}>
          <line x1="6" y1="3" x2="6" y2="15" />
          <circle cx="18" cy="6" r="3" />
          <circle cx="6" cy="18" r="3" />
          <path d="M18 9a9 9 0 0 1-9 9" />
        </svg>
        {branch}
      </span>

      {/* Spacer */}
      <span style={{ flex: 1 }} />

      {/* Diff pill — tappable */}
      {hasDiff && (
        <button
          type="button"
          onClick={onOpenDiff}
          style={{
            display: 'flex', alignItems: 'center', gap: 4,
            padding: '3px 8px',
            borderRadius: 6,
            background: 'rgba(0,0,0,0.03)',
            border: '1px solid rgba(0,0,0,0.06)',
            cursor: 'pointer',
            WebkitTapHighlightColor: 'transparent',
            flexShrink: 0,
          }}
        >
          <span style={{
            fontSize: 11, fontWeight: 700, color: '#34c759',
            fontFamily: '"SF Mono", ui-monospace, monospace',
          }}>
            +{totalAdd}
          </span>
          <span style={{
            fontSize: 11, fontWeight: 700, color: '#ff3b30',
            fontFamily: '"SF Mono", ui-monospace, monospace',
          }}>
            -{totalDel}
          </span>
        </button>
      )}

      {/* Context % */}
      <span style={{
        fontSize: 10, fontWeight: 600,
        color: toneColor,
        fontFamily: '"SF Mono", ui-monospace, monospace',
        flexShrink: 0,
      }}>
        {status.headline}
      </span>
    </div>
  );
});
