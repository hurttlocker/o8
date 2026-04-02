/**
 * ConflictSheet — Expandable detail panel for worktree conflicts.
 *
 * Shows: file overlaps, severity, line ranges, merge order recommendation.
 * Triggered by tapping conflict badge in WorktreeBadge or WorktreeSummary.
 *
 * @see https://github.com/hurttlocker/cortex-ide/issues/69
 */

import { memo, useCallback, useState } from 'react';
import type { EnhancedConflictReport, FileConflictDetail, MergeOrderRecommendation } from '@/lib/worktree/conflicts';

interface ConflictSheetProps {
  report: EnhancedConflictReport | null;
  open: boolean;
  onClose: () => void;
  onMergeFirst: (worktreeId: string) => void;
  onAnalyzeDeep: () => void | Promise<void>;
}

const SEVERITY_COLORS = {
  conflict: '#ff3b30',
  warning: '#ff9f0a',
} as const;

const AGENT_COLORS: Record<string, string> = {
  'claude-code': '#cc785c',
  'codex': '#10a37f',
};

export const ConflictSheet = memo(function ConflictSheet({
  report,
  open,
  onClose,
  onMergeFirst,
  onAnalyzeDeep,
}: ConflictSheetProps) {
  const [analyzing, setAnalyzing] = useState(false);

  const handleDeepAnalysis = useCallback(async () => {
    setAnalyzing(true);
    try {
      await onAnalyzeDeep();
    } finally {
      setAnalyzing(false);
    }
  }, [onAnalyzeDeep]);

  if (!open || !report) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-end',
      }}
    >
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'absolute',
          inset: 0,
          backgroundColor: 'rgba(0,0,0,0.5)',
          backdropFilter: 'blur(4px)',
          WebkitBackdropFilter: 'blur(4px)',
        }}
      />

      {/* Sheet */}
      <div
        style={{
          position: 'relative',
          backgroundColor: '#1c1c1e',
          borderRadius: '20px 20px 0 0',
          maxHeight: '75vh',
          overflowY: 'auto',
          padding: '20px 16px',
          animation: 'conflict-sheet-slide-up 0.25s ease-out',
        }}
      >
        <style>{`
          @keyframes conflict-sheet-slide-up {
            from { transform: translateY(100%); }
            to { transform: translateY(0); }
          }
        `}</style>

        {/* Handle bar */}
        <div
          style={{
            width: '36px',
            height: '4px',
            borderRadius: '2px',
            backgroundColor: '#48484a',
            margin: '0 auto 16px',
          }}
        />

        {/* Header */}
        <div style={{ marginBottom: '16px' }}>
          <h3
            style={{
              fontSize: '17px',
              fontWeight: 700,
              color: '#e5e5ea',
              letterSpacing: '-0.02em',
              margin: 0,
            }}
          >
            Worktree Conflicts
          </h3>
          <p
            style={{
              fontSize: '13px',
              color: '#A09890',
              margin: '4px 0 0',
            }}
          >
            {report.conflictCount} conflict{report.conflictCount !== 1 ? 's' : ''}
            {report.warningCount > 0 ? ` · ${report.warningCount} warning${report.warningCount !== 1 ? 's' : ''}` : ''}
          </p>
        </div>

        {/* File Conflicts */}
        {report.files.length > 0 ? (
          <div style={{ marginBottom: '20px' }}>
            <h4
              style={{
                fontSize: '13px',
                fontWeight: 600,
                color: '#A09890',
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
                margin: '0 0 8px',
              }}
            >
              Overlapping Files
            </h4>

            {report.files.map((conflict, idx) => (
              <FileConflictRow key={`${conflict.file}-${idx}`} conflict={conflict} />
            ))}

            {/* Deep analysis button */}
            {report.files.some((f) => !f.rangesA) ? (
              <button
                type="button"
                onClick={handleDeepAnalysis}
                disabled={analyzing}
                style={{
                  width: '100%',
                  padding: '10px',
                  marginTop: '8px',
                  borderRadius: '10px',
                  backgroundColor: 'rgba(0,122,255,0.12)',
                  border: 'none',
                  color: '#007aff',
                  fontSize: '13px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  opacity: analyzing ? 0.6 : 1,
                  WebkitTapHighlightColor: 'transparent',
                }}
              >
                {analyzing ? 'Analyzing line ranges…' : 'Analyze line ranges'}
              </button>
            ) : null}
          </div>
        ) : null}

        {/* Merge Order Recommendation */}
        {report.mergeOrder.length > 1 ? (
          <div style={{ marginBottom: '16px' }}>
            <h4
              style={{
                fontSize: '13px',
                fontWeight: 600,
                color: '#A09890',
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
                margin: '0 0 8px',
              }}
            >
              Recommended Merge Order
            </h4>

            {report.mergeOrder.map((rec) => (
              <MergeOrderRow
                key={rec.worktreeId}
                recommendation={rec}
                onMergeFirst={() => onMergeFirst(rec.worktreeId)}
              />
            ))}
          </div>
        ) : null}

        {/* Close button */}
        <button
          type="button"
          onClick={onClose}
          style={{
            width: '100%',
            padding: '14px',
            borderRadius: '12px',
            backgroundColor: 'rgba(255,248,240,0.07)',
            border: 'none',
            color: '#e5e5ea',
            fontSize: '15px',
            fontWeight: 600,
            cursor: 'pointer',
            WebkitTapHighlightColor: 'transparent',
          }}
        >
          Done
        </button>
      </div>
    </div>
  );
});

// ── Sub-Components ──

const FileConflictRow = memo(function FileConflictRow({
  conflict,
}: {
  conflict: FileConflictDetail;
}) {
  const color = SEVERITY_COLORS[conflict.severity];
  const fileName = conflict.file.split('/').pop() ?? conflict.file;
  const dirPath = conflict.file.includes('/')
    ? conflict.file.slice(0, conflict.file.lastIndexOf('/'))
    : '';

  return (
    <div
      style={{
        padding: '10px 12px',
        marginBottom: '4px',
        borderRadius: '10px',
        backgroundColor: 'rgba(255,255,255,0.04)',
        borderLeft: `3px solid ${color}`,
      }}
    >
      {/* File path */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
        <span
          style={{
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            backgroundColor: color,
            flexShrink: 0,
          }}
        />
        <span style={{ fontSize: '13px', fontWeight: 600, color: '#e5e5ea' }}>
          {fileName}
        </span>
        <span
          style={{
            fontSize: '10px',
            fontWeight: 600,
            color,
            textTransform: 'uppercase',
            letterSpacing: '0.02em',
          }}
        >
          {conflict.severity}
        </span>
      </div>

      {dirPath ? (
        <div style={{ fontSize: '11px', color: '#706860', marginBottom: '4px', marginLeft: '12px' }}>
          {dirPath}
        </div>
      ) : null}

      {/* Worktree names */}
      <div style={{ fontSize: '11px', color: '#A09890', marginLeft: '12px' }}>
        {conflict.worktreeA} ↔ {conflict.worktreeB}
      </div>

      {/* Line ranges (if available from deep analysis) */}
      {conflict.rangesA && conflict.rangesB ? (
        <div style={{ marginTop: '6px', marginLeft: '12px', fontSize: '11px' }}>
          <div style={{ color: '#A09890' }}>
            {conflict.worktreeA}: lines {formatRanges(conflict.rangesA)}
          </div>
          <div style={{ color: '#A09890' }}>
            {conflict.worktreeB}: lines {formatRanges(conflict.rangesB)}
          </div>
          {conflict.overlappingRanges && conflict.overlappingRanges.length > 0 ? (
            <div style={{ color: '#ff3b30', fontWeight: 600, marginTop: '2px' }}>
              ⚠ Overlap: lines {conflict.overlappingRanges.map((r) => `${r.start}-${r.end}`).join(', ')}
            </div>
          ) : (
            <div style={{ color: '#34c759', marginTop: '2px' }}>
              ✓ Different sections — safe to merge sequentially
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
});

const MergeOrderRow = memo(function MergeOrderRow({
  recommendation,
  onMergeFirst,
}: {
  recommendation: MergeOrderRecommendation;
  onMergeFirst: () => void;
}) {
  const color = AGENT_COLORS[recommendation.agentType] ?? '#A09890';

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '10px 12px',
        marginBottom: '4px',
        borderRadius: '10px',
        backgroundColor: 'rgba(255,255,255,0.04)',
      }}
    >
      {/* Position number */}
      <span
        style={{
          width: '24px',
          height: '24px',
          borderRadius: '12px',
          backgroundColor: recommendation.position === 1 ? '#007aff' : '#48484a',
          color: '#fff',
          fontSize: '13px',
          fontWeight: 700,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        {recommendation.position}
      </span>

      {/* Details */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span
            style={{
              width: '6px',
              height: '6px',
              borderRadius: '50%',
              backgroundColor: color,
              flexShrink: 0,
            }}
          />
          <span style={{ fontSize: '13px', fontWeight: 600, color: '#e5e5ea' }}>
            {recommendation.worktreeId}
          </span>
          <span style={{ fontSize: '11px', color: '#A09890' }}>
            {recommendation.fileCount}f · {recommendation.totalChanges}Δ
          </span>
        </div>
        <div style={{ fontSize: '11px', color: '#A09890', marginTop: '2px' }}>
          {recommendation.reason}
        </div>
      </div>

      {/* Action */}
      {recommendation.position === 1 ? (
        <button
          type="button"
          onClick={onMergeFirst}
          style={{
            padding: '5px 10px',
            borderRadius: '8px',
            backgroundColor: '#007aff',
            border: 'none',
            color: '#fff',
            fontSize: '11px',
            fontWeight: 600,
            cursor: 'pointer',
            flexShrink: 0,
            WebkitTapHighlightColor: 'transparent',
          }}
        >
          Merge first
        </button>
      ) : null}
    </div>
  );
});

// ── Helpers ──

function formatRanges(ranges: Array<{ start: number; count: number }>): string {
  return ranges
    .map((r) => r.count === 1 ? `${r.start}` : `${r.start}-${r.start + r.count - 1}`)
    .join(', ');
}
