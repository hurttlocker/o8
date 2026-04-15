'use client';

import React, { memo, useCallback, useMemo, useState } from 'react';
import { Check, Copy, FileCode } from './lucide-shims';
import { DiffStatusIcon } from './diff-utils';

const THEME_ACCENT = 'var(--t-accent, #2563eb)';
const THEME_ACCENT_SOFT = 'var(--t-accent-soft, rgba(37, 99, 235, 0.08))';
const THEME_BG_CARD = 'var(--t-bg-card, rgba(148, 163, 184, 0.08))';
const THEME_PANEL_GLASS = 'var(--t-panel-translucent)';

export interface DiffCardProps {
  code: string;
  onApplyDiff?: (diffText: string) => void;
}

interface ParsedDiffHunk {
  header: string;
  lines: string[];
}

interface ParsedDiffFile {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  hunks: ParsedDiffHunk[];
}

function normalizeDiffPath(rawPath: string) {
  const trimmed = rawPath.trim();
  if (trimmed === '/dev/null') return trimmed;
  return trimmed.replace(/^[ab]\//, '');
}

function getDiffFileStatus(oldPath: string, newPath: string): ParsedDiffFile['status'] {
  if (oldPath === '/dev/null') return 'added';
  if (newPath === '/dev/null') return 'deleted';
  return 'modified';
}

function getDiffTargetPath(oldPath: string, newPath: string) {
  return newPath !== '/dev/null' ? normalizeDiffPath(newPath) : normalizeDiffPath(oldPath);
}

function parseUnifiedDiff(rawDiff: string): ParsedDiffFile[] {
  const lines = rawDiff.replace(/\r\n/g, '\n').split('\n');
  const files: ParsedDiffFile[] = [];
  let currentFile: ParsedDiffFile | null = null;
  let currentHunk: ParsedDiffHunk | null = null;

  const pushCurrentHunk = () => {
    if (!currentFile || !currentHunk) return;
    currentFile.hunks.push(currentHunk);
    currentHunk = null;
  };

  const pushCurrentFile = () => {
    if (!currentFile) return;
    pushCurrentHunk();
    if (currentFile.path) {
      files.push(currentFile);
    }
    currentFile = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const nextLine = lines[index + 1] ?? '';

    if (!currentHunk && line.startsWith('--- ') && nextLine.startsWith('+++ ')) {
      pushCurrentFile();
      const oldPath = line.slice(4).trim();
      const newPath = nextLine.slice(4).trim();
      currentFile = {
        path: getDiffTargetPath(oldPath, newPath),
        status: getDiffFileStatus(oldPath, newPath),
        hunks: [],
      };
      index += 1;
      continue;
    }

    if (!currentFile) {
      continue;
    }

    if (line.startsWith('@@')) {
      pushCurrentHunk();
      currentHunk = { header: line, lines: [] };
      continue;
    }

    if (currentHunk) {
      currentHunk.lines.push(line);
    }
  }

  pushCurrentFile();
  return files;
}

function DiffCardHunk({ hunk }: { hunk: ParsedDiffHunk }) {
  const hunkMatch = hunk.header.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  const startOldLine = hunkMatch ? Number.parseInt(hunkMatch[1], 10) : 1;
  const startNewLine = hunkMatch ? Number.parseInt(hunkMatch[2], 10) : 1;
  const rows = useMemo(() => {
    return hunk.lines.reduce<{
      oldLine: number;
      newLine: number;
      rows: Array<{
        key: string;
        line: string;
        color: string;
        background: string;
        leftNum: string;
        rightNum: string;
      }>;
    }>((state, line, lineIndex) => {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        return {
          oldLine: state.oldLine,
          newLine: state.newLine + 1,
          rows: [
            ...state.rows,
            {
              key: `${hunk.header}-${lineIndex}`,
              line,
              color: '#166534',
              background: 'rgba(34, 197, 94, 0.08)',
              leftNum: '',
              rightNum: String(state.newLine),
            },
          ],
        };
      }

      if (line.startsWith('-') && !line.startsWith('---')) {
        return {
          oldLine: state.oldLine + 1,
          newLine: state.newLine,
          rows: [
            ...state.rows,
            {
              key: `${hunk.header}-${lineIndex}`,
              line,
              color: '#991b1b',
              background: 'rgba(239, 68, 68, 0.08)',
              leftNum: String(state.oldLine),
              rightNum: '',
            },
          ],
        };
      }

      if (line.startsWith('\\')) {
        return {
          oldLine: state.oldLine,
          newLine: state.newLine,
          rows: [
            ...state.rows,
            {
              key: `${hunk.header}-${lineIndex}`,
              line,
              color: 'var(--t-text-muted)',
              background: 'transparent',
              leftNum: '',
              rightNum: '',
            },
          ],
        };
      }

      return {
        oldLine: state.oldLine + 1,
        newLine: state.newLine + 1,
        rows: [
          ...state.rows,
          {
            key: `${hunk.header}-${lineIndex}`,
            line,
            color: 'var(--t-text)',
            background: 'transparent',
            leftNum: String(state.oldLine),
            rightNum: String(state.newLine),
          },
        ],
      };
    }, {
      oldLine: startOldLine,
      newLine: startNewLine,
      rows: [],
    }).rows;
  }, [hunk.header, hunk.lines, startNewLine, startOldLine]);

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          paddingTop: 6,
          paddingRight: 12,
          paddingBottom: 6,
          paddingLeft: 12,
          background: 'rgba(99, 102, 241, 0.06)',
          color: '#6366f1',
          fontSize: 12,
          fontFamily: '"SF Mono", ui-monospace, monospace',
          borderTop: '1px solid var(--t-divider-subtle)',
          borderBottom: '1px solid var(--t-divider-subtle)',
        }}
      >
        <span style={{ flex: 1 }}>{hunk.header}</span>
      </div>
      {rows.map((row) => {
        return (
          <div
            key={row.key}
            style={{
              display: 'flex',
              color: row.color,
              background: row.background,
            }}
          >
            <span
              style={{
                width: 42,
                flexShrink: 0,
                textAlign: 'right',
                paddingTop: 1,
                paddingRight: 6,
                paddingBottom: 1,
                paddingLeft: 0,
                color: 'var(--t-text-faint)',
                fontSize: 12,
                fontFamily: '"SF Mono", ui-monospace, monospace',
                userSelect: 'none',
                borderRight: '1px solid var(--t-divider-subtle)',
              }}
            >
              {row.leftNum}
            </span>
            <span
              style={{
                width: 42,
                flexShrink: 0,
                textAlign: 'right',
                paddingTop: 1,
                paddingRight: 6,
                paddingBottom: 1,
                paddingLeft: 0,
                color: 'var(--t-text-faint)',
                fontSize: 12,
                fontFamily: '"SF Mono", ui-monospace, monospace',
                userSelect: 'none',
                borderRight: '1px solid var(--t-divider-subtle)',
              }}
            >
              {row.rightNum}
            </span>
            <span
              style={{
                flex: 1,
                paddingTop: 1,
                paddingRight: 12,
                paddingBottom: 1,
                paddingLeft: 8,
                fontSize: 12,
                lineHeight: 1.5,
                fontFamily: '"SF Mono", ui-monospace, monospace',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {row.line || '\u00A0'}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export const DiffCard = memo(function DiffCard({ code, onApplyDiff }: DiffCardProps) {
  const [copied, setCopied] = useState(false);
  const [applied, setApplied] = useState(false);
  const files = useMemo(() => parseUnifiedDiff(code), [code]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [code]);

  const handleApply = useCallback(() => {
    if (!onApplyDiff) return;
    onApplyDiff(code);
    setApplied(true);
    setTimeout(() => setApplied(false), 2000);
  }, [code, onApplyDiff]);

  return (
    <div
      style={{
        marginTop: 8,
        marginBottom: 8,
        borderRadius: 10,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-panel-border)',
        background: THEME_PANEL_GLASS,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          paddingTop: 6,
          paddingRight: 8,
          paddingBottom: 6,
          paddingLeft: 12,
          background: THEME_BG_CARD,
          borderBottom: '1px solid var(--t-divider)',
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--t-text-secondary)',
            fontFamily: '"SF Mono", ui-monospace, monospace',
          }}
        >
          diff
        </span>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <button
            type="button"
            onClick={handleCopy}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              minHeight: 44,
              paddingTop: 0,
              paddingRight: 10,
              paddingBottom: 0,
              paddingLeft: 10,
              borderWidth: 0,
              borderRadius: 8,
              background: 'transparent',
              color: copied ? '#10b981' : 'var(--t-text-muted)',
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
              transition: 'color 150ms, background 150ms',
            }}
            onMouseEnter={(event) => {
              if (copied) return;
              event.currentTarget.style.background = THEME_BG_CARD;
              event.currentTarget.style.color = 'var(--t-text-secondary)';
            }}
            onMouseLeave={(event) => {
              event.currentTarget.style.background = 'transparent';
              if (!copied) event.currentTarget.style.color = 'var(--t-text-muted)';
            }}
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button
            type="button"
            onClick={handleApply}
            disabled={!onApplyDiff}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              minHeight: 44,
              paddingTop: 0,
              paddingRight: 12,
              paddingBottom: 0,
              paddingLeft: 12,
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: 'var(--t-accent-border, rgba(37, 99, 235, 0.22))',
              borderRadius: 8,
              background: applied ? THEME_ACCENT_SOFT : THEME_ACCENT,
              color: applied ? '#10b981' : '#ffffff',
              fontSize: 11,
              fontWeight: 700,
              cursor: onApplyDiff ? 'pointer' : 'not-allowed',
              opacity: onApplyDiff ? 1 : 0.6,
              fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
              transition: 'background 150ms, color 150ms, opacity 150ms',
            }}
            onMouseEnter={(event) => {
              if (!onApplyDiff || applied) return;
              event.currentTarget.style.background = 'var(--t-accent-strong, #1d4ed8)';
            }}
            onMouseLeave={(event) => {
              if (!onApplyDiff || applied) return;
              event.currentTarget.style.background = THEME_ACCENT;
            }}
          >
            {applied ? <Check size={12} /> : <FileCode size={12} />}
            {applied ? 'Applied' : 'Apply'}
          </button>
        </div>
      </div>

      {files.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {files.map((file, fileIndex) => (
            <div
              key={`${file.path}-${fileIndex}`}
              style={{
                borderTop: fileIndex === 0 ? 'none' : '1px solid var(--t-divider)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  paddingTop: 10,
                  paddingRight: 12,
                  paddingBottom: 10,
                  paddingLeft: 12,
                  background: 'var(--t-bg-card, rgba(148, 163, 184, 0.05))',
                  borderBottom: file.hunks.length > 0 ? '1px solid var(--t-divider-subtle)' : 'none',
                }}
              >
                <DiffStatusIcon status={file.status} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 700,
                      color: 'var(--t-text)',
                      lineHeight: 1.4,
                      wordBreak: 'break-word',
                    }}
                  >
                    {file.path}
                  </div>
                </div>
              </div>
              {file.hunks.length > 0 ? (
                file.hunks.map((hunk, hunkIndex) => (
                  <DiffCardHunk key={`${file.path}-hunk-${hunkIndex}`} hunk={hunk} />
                ))
              ) : (
                <div
                  style={{
                    paddingTop: 12,
                    paddingRight: 12,
                    paddingBottom: 12,
                    paddingLeft: 12,
                    fontSize: 12,
                    color: 'var(--t-text-muted)',
                    fontFamily: '"SF Mono", ui-monospace, monospace',
                  }}
                >
                  No hunks parsed from this diff section.
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <pre
          style={{
            marginTop: 0,
            marginRight: 0,
            marginBottom: 0,
            marginLeft: 0,
            paddingTop: 12,
            paddingRight: 16,
            paddingBottom: 12,
            paddingLeft: 16,
            fontSize: 13,
            lineHeight: 1.6,
            fontFamily: '"SF Mono", ui-monospace, "Cascadia Code", monospace',
            overflowX: 'auto',
            color: 'var(--t-text-secondary)',
            tabSize: 2,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {code}
        </pre>
      )}
    </div>
  );
});
