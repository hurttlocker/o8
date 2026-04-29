'use client';

import { useCallback, useMemo, useState } from 'react';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { parseGitDiff } from '@/lib/worktree/diff-parser';
import type { ReviewPanelState } from '../types';
import {
  DiffPayload,
  FONT_FAMILY,
  MONO_FAMILY,
  ParsedFileDiff,
  paneLabelStyle,
  paneStyle,
} from './shared';

const MAX_INITIAL_LINES = 200;

/**
 * Renders a patch body capped at MAX_INITIAL_LINES lines with an expand button.
 * Mirrors the HunkBlock "Expand N more lines" pattern from InlineDiffViewer.
 */
function ExpandablePatch({ patch }: { patch: string }) {
  const [showAll, setShowAll] = useState(false);
  const allLines = patch.split('\n');
  const visibleLines = showAll ? allLines : allLines.slice(0, MAX_INITIAL_LINES);
  const hiddenCount = Math.max(0, allLines.length - visibleLines.length);
  return (
    <div style={{
      borderTopWidth: 1,
      borderTopStyle: 'solid',
      borderTopColor: 'var(--t-divider-subtle)',
      background: 'var(--t-bg)',
    }}>
      <pre style={{
        margin: 0,
        paddingTop: 6,
        paddingRight: 10,
        paddingBottom: 6,
        paddingLeft: 10,
        fontSize: 10,
        fontFamily: MONO_FAMILY,
        color: 'var(--t-text)',
        overflowX: 'auto',
        whiteSpace: 'pre',
        lineHeight: 1.5,
      }}>
        {visibleLines.map((line, idx) => {
          let color = 'var(--t-text-secondary)';
          if (line.startsWith('+') && !line.startsWith('+++')) color = '#16a34a';
          else if (line.startsWith('-') && !line.startsWith('---')) color = '#dc2626';
          else if (line.startsWith('@@')) color = '#7c3aed';
          return (
            <div key={idx} style={{ color, whiteSpace: 'pre' }}>
              {line || ' '}
            </div>
          );
        })}
      </pre>
      {hiddenCount > 0 ? (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          style={{
            width: '100%',
            minHeight: 28,
            borderWidth: 0,
            borderTopWidth: 1,
            borderTopStyle: 'solid',
            borderTopColor: 'var(--t-divider-subtle)',
            background: 'var(--t-panel-translucent)',
            color: 'var(--t-text-secondary)',
            fontSize: 10,
            fontWeight: 600,
            cursor: 'pointer',
            fontFamily: FONT_FAMILY,
            letterSpacing: '-0.01em',
          }}
        >
          Expand full diff ({hiddenCount} more line{hiddenCount === 1 ? '' : 's'})
        </button>
      ) : null}
    </div>
  );
}

/**
 * #729 — DIFF pane: file tree with +/- totals + per-file unified diff with
 * hunk-level expansion.
 */
function toFileDiffs(rawDiff: string): ParsedFileDiff[] {
  const sections = parseGitDiff(rawDiff);
  return sections.map((section) => {
    let additions = 0;
    let deletions = 0;
    for (const line of section.patch.split('\n')) {
      if (line.startsWith('+++') || line.startsWith('---')) continue;
      if (line.startsWith('+')) additions += 1;
      else if (line.startsWith('-')) deletions += 1;
    }
    return { path: section.path, additions, deletions, patch: section.patch, status: section.status };
  });
}

export function DiffPane({ packet, reviewState, diff, diffLoading, diffError }: {
  packet: OrchestratorPacket;
  reviewState: ReviewPanelState | null;
  diff: DiffPayload | null;
  diffLoading: boolean;
  diffError: string | null;
}) {
  const [expandedFiles, setExpandedFiles] = useState<Record<string, boolean>>({});
  const fileDiffs = useMemo(() => diff ? toFileDiffs(diff.diff) : [], [diff]);
  const toggleFile = useCallback((path: string) => {
    setExpandedFiles((current) => ({ ...current, [path]: !current[path] }));
  }, []);

  // Fall back to reviewState file list when raw diff is in flight.
  const fallbackFiles = (reviewState?.snapshot?.changedFiles ?? []).map((file) => ({
    path: file.path,
    additions: file.additions ?? 0,
    deletions: file.deletions ?? 0,
    patch: '',
    status: 'M' as ParsedFileDiff['status'],
  }));
  const filesToRender = fileDiffs.length > 0 ? fileDiffs : fallbackFiles;

  return (
    <div style={paneStyle()}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <div style={paneLabelStyle()}>DIFF</div>
        {diff ? (
          <div style={{
            fontSize: 10,
            color: 'var(--t-text-muted)',
            fontFamily: MONO_FAMILY,
          }}>
            <span style={{ color: '#16a34a' }}>+{diff.additions}</span>
            {' '}
            <span style={{ color: '#dc2626' }}>-{diff.deletions}</span>
            {' '}
            <span>· {diff.fileCount} files</span>
          </div>
        ) : null}
      </div>

      {diffLoading ? (
        <div style={{ fontSize: 10.5, color: 'var(--t-text-muted)', fontFamily: FONT_FAMILY }}>
          Loading diff…
        </div>
      ) : null}

      {diffError ? (
        <div style={{ fontSize: 10.5, color: '#b91c1c', fontFamily: FONT_FAMILY }}>
          {diffError}
        </div>
      ) : null}

      {!diffLoading && !diffError && filesToRender.length === 0 ? (
        <div style={{ fontSize: 10.5, color: 'var(--t-text-muted)', fontFamily: FONT_FAMILY }}>
          Working tree clean.
        </div>
      ) : null}

      {filesToRender.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {filesToRender.map((file) => {
            const isExpanded = expandedFiles[file.path] === true;
            const canExpand = file.patch.length > 0;
            return (
              <div
                key={`${packet.id}:${file.path}`}
                style={{
                  borderRadius: 8,
                  borderWidth: 1,
                  borderStyle: 'solid',
                  borderColor: 'var(--t-divider)',
                  background: 'var(--t-bg-subtle)',
                  overflow: 'hidden',
                }}
              >
                <button
                  type="button"
                  onClick={canExpand ? () => toggleFile(file.path) : undefined}
                  disabled={!canExpand}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    paddingTop: 5,
                    paddingRight: 8,
                    paddingBottom: 5,
                    paddingLeft: 8,
                    borderWidth: 0,
                    background: 'transparent',
                    cursor: canExpand ? 'pointer' : 'default',
                    textAlign: 'left',
                    fontFamily: FONT_FAMILY,
                  }}
                >
                  {canExpand ? (
                    <svg width={9} height={9} viewBox="0 0 10 10" fill="none" stroke="var(--t-text-muted)" strokeWidth="1.5" strokeLinecap="round" style={{ flexShrink: 0, transform: isExpanded ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 120ms cubic-bezier(0.22, 1, 0.36, 1)' }}>
                      <path d="M2.5 3.5L5 6L7.5 3.5" />
                    </svg>
                  ) : <span style={{ width: 9, flexShrink: 0 }} />}
                  <span style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 10.5,
                    color: 'var(--t-text)',
                    fontFamily: MONO_FAMILY,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>
                    {file.path}
                  </span>
                  <span style={{
                    flexShrink: 0,
                    fontSize: 10,
                    fontWeight: 700,
                    fontFamily: MONO_FAMILY,
                    display: 'inline-flex',
                    gap: 6,
                  }}>
                    <span style={{ color: '#16a34a' }}>+{file.additions}</span>
                    <span style={{ color: '#dc2626' }}>-{file.deletions}</span>
                  </span>
                </button>
                {isExpanded && file.patch ? (
                  <ExpandablePatch patch={file.patch} />
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
