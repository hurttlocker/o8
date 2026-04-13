'use client';
/* eslint-disable @typescript-eslint/no-unused-vars -- extracted from Canvas.tsx */

import { useMemo, useRef, useState } from 'react';
import {
  ChevronRight,
  FileEdit,
  FileMinus,
  FilePlus,
  FileText,
} from './lucide-shims';
import { measureHeight } from '@/lib/pretext';

const diffStatusColors: Record<string, string> = {
  added: '#22c55e',
  modified: '#f59e0b',
  deleted: '#ef4444',
  renamed: '#8b5cf6',
  untracked: '#6b7280',
};

export function DiffStatusIcon({ status }: { status: string }) {
  const color = diffStatusColors[status] ?? '#6b7280';
  const size = 15;
  switch (status) {
    case 'added': return <FilePlus size={size} strokeWidth={1.8} style={{ color, flexShrink: 0 }} />;
    case 'deleted': return <FileMinus size={size} strokeWidth={1.8} style={{ color, flexShrink: 0 }} />;
    case 'modified': return <FileEdit size={size} strokeWidth={1.8} style={{ color, flexShrink: 0 }} />;
    default: return <FileText size={size} strokeWidth={1.8} style={{ color, flexShrink: 0 }} />;
  }
}

// [pretext] Two 42px line-number gutters + 8px paddingLeft = 92px of non-content width in each hunk row.
const DIFF_HUNK_GUTTER_WIDTH = 92;

function DiffHunk({ hunkHeader, lines, startIndex, defaultExpanded, containerWidth = 0 }: {
  hunkHeader: string;
  lines: string[];
  startIndex: number;
  defaultExpanded: boolean;
  containerWidth?: number;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  // [pretext] Batch-measure all line heights up front — pure math after first prepare().
  // Must run unconditionally (before any conditional rendering) to preserve hook order.
  const contentWidth = containerWidth > 0 ? containerWidth - DIFF_HUNK_GUTTER_WIDTH : 0;
  const lineHeights = useMemo(() => {
    if (contentWidth <= 0) return null;
    console.log('[pretext] DiffHunk measuring', lines.length, 'lines at width', contentWidth);
    return lines.map((line) =>
      measureHeight(line || '\u00A0', 'mono', contentWidth, 1.5, 'pre-wrap'),
    );
  }, [lines, contentWidth]);

  // Parse line numbers from @@ -old,len +new,len @@
  const hunkMatch = hunkHeader.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  let oldLine = hunkMatch ? parseInt(hunkMatch[1], 10) : 1;
  let newLine = hunkMatch ? parseInt(hunkMatch[2], 10) : 1;

  return (
    <div>
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          paddingTop: 4,
          paddingRight: 12,
          paddingBottom: 4,
          paddingLeft: 8,
          background: 'rgba(99, 102, 241, 0.06)',
          color: '#6366f1',
          fontSize: '0.75rem',
          fontFamily: '"SF Mono", ui-monospace, monospace',
          cursor: 'pointer',
          userSelect: 'none',
          borderTop: '1px solid var(--t-divider-subtle)',
          borderBottom: '1px solid var(--t-divider-subtle)',
        }}
      >
        <ChevronRight
          size={11}
          style={{
            transition: 'transform 150ms ease',
            transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
            flexShrink: 0,
          }}
        />
        <span style={{ flex: 1 }}>{hunkHeader}</span>
        <span style={{ color: 'var(--t-text-muted)', fontSize: 10 }}>{lines.length} lines</span>
      </div>
      {expanded && lines.map((line, i) => {
        let color = 'var(--t-text)';
        let bg = 'transparent';
        let leftNum: string = '';
        let rightNum: string = '';

        if (line.startsWith('+') && !line.startsWith('+++')) {
          color = '#166534';
          bg = 'rgba(34, 197, 94, 0.08)';
          rightNum = String(newLine++);
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          color = '#991b1b';
          bg = 'rgba(239, 68, 68, 0.08)';
          leftNum = String(oldLine++);
        } else {
          leftNum = String(oldLine++);
          rightNum = String(newLine++);
        }

        // [pretext] When we have a measured height, set it explicitly to eliminate reflow.
        const measuredHeight = lineHeights?.[i];
        const rowStyle: React.CSSProperties = measuredHeight
          ? { display: 'flex', color, background: bg, height: measuredHeight, overflow: 'hidden' }
          : { display: 'flex', color, background: bg };

        return (
          <div key={startIndex + i} style={rowStyle}>
            <span style={{
              width: 42,
              flexShrink: 0,
              textAlign: 'right',
              paddingRight: 6,
              color: 'var(--t-text-faint)',
              fontSize: 12,
              fontFamily: '"SF Mono", ui-monospace, monospace',
              userSelect: 'none',
              borderRight: '1px solid var(--t-divider-subtle)',
            }}>{leftNum}</span>
            <span style={{
              width: 42,
              flexShrink: 0,
              textAlign: 'right',
              paddingRight: 6,
              color: 'var(--t-text-faint)',
              fontSize: 12,
              fontFamily: '"SF Mono", ui-monospace, monospace',
              userSelect: 'none',
              borderRight: '1px solid var(--t-divider-subtle)',
            }}>{rightNum}</span>
            <span style={{
              flex: 1,
              paddingLeft: 8,
              paddingTop: 1,
              paddingBottom: 1,
              fontSize: 12,
              lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}>{line || '\u00A0'}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── Lightweight syntax highlighting ──

function getFileLanguage(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
    md: 'markdown', mdx: 'markdown',
    env: 'env', sh: 'shell', bash: 'shell', zsh: 'shell',
    css: 'css', scss: 'css', html: 'html', xml: 'html',
    py: 'python', rs: 'rust', go: 'go', rb: 'ruby',
    sql: 'sql', graphql: 'graphql', gql: 'graphql',
    dockerfile: 'docker', gitignore: 'config',
  };
  const name = path.split('/').pop()?.toLowerCase() ?? '';
  if (name.startsWith('.env')) return 'env';
  if (name === 'dockerfile') return 'docker';
  if (name === '.gitignore' || name === '.dockerignore') return 'config';
  return map[ext] || 'text';
}

const syntaxColors = {
  keyword: '#c678dd',    // purple
  string: '#98c379',     // green
  number: '#d19a66',     // orange
  comment: '#5c6370',    // gray
  property: '#e06c75',   // red
  type: '#e5c07b',       // yellow
  punctuation: '#abb2bf', // light gray
  env_key: '#e06c75',    // red
  env_value: '#98c379',  // green
  env_equals: '#56b6c2', // cyan
};

function highlightLine(line: string, lang: string): React.ReactNode {
  // ENV files: KEY=VALUE
  if (lang === 'env') {
    if (line.startsWith('#')) return <span style={{ color: syntaxColors.comment }}>{line}</span>;
    const eqIdx = line.indexOf('=');
    if (eqIdx > 0) {
      return (
        <>
          <span style={{ color: syntaxColors.env_key }}>{line.slice(0, eqIdx)}</span>
          <span style={{ color: syntaxColors.env_equals }}>=</span>
          <span style={{ color: syntaxColors.env_value }}>{line.slice(eqIdx + 1)}</span>
        </>
      );
    }
    return line;
  }

  // JSON: basic key/value coloring
  if (lang === 'json') {
    return line.replace(/^(\s*)("(?:[^"\\]|\\.)*")(\s*:\s*)?/g, (_match, indent, key, colon) => {
      // This is a simplified approach — return the raw line with spans
      void indent; void key; void colon;
      return _match;
    }) ? <span dangerouslySetInnerHTML={{ __html:
      line
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/("(?:[^"\\]|\\.)*")(\s*:)/g, `<span style="color:${syntaxColors.property}">$1</span>$2`)
        .replace(/:(\s*"(?:[^"\\]|\\.)*")/g, `:<span style="color:${syntaxColors.string}">$1</span>`)
        .replace(/:(\s*(?:\d+\.?\d*|true|false|null))/g, `:<span style="color:${syntaxColors.number}">$1</span>`)
    }} /> : <>{line}</>;
  }

  // TypeScript/JavaScript: basic keyword highlighting
  if (lang === 'typescript' || lang === 'javascript') {
    if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*') || line.trimStart().startsWith('/*')) {
      return <span style={{ color: syntaxColors.comment }}>{line}</span>;
    }
    return <span dangerouslySetInnerHTML={{ __html:
      line
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/\b(import|export|from|const|let|var|function|return|if|else|for|while|class|interface|type|extends|implements|async|await|new|throw|try|catch|finally|typeof|instanceof|in|of|default|switch|case|break|continue|void|null|undefined|true|false)\b/g,
          `<span style="color:${syntaxColors.keyword}">$1</span>`)
        .replace(/('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)/g,
          `<span style="color:${syntaxColors.string}">$1</span>`)
        .replace(/\b(\d+\.?\d*)\b/g, `<span style="color:${syntaxColors.number}">$1</span>`)
    }} />;
  }

  // YAML: key: value
  if (lang === 'yaml') {
    if (line.trimStart().startsWith('#')) return <span style={{ color: syntaxColors.comment }}>{line}</span>;
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0 && !line.trimStart().startsWith('-')) {
      return (
        <>
          <span style={{ color: syntaxColors.property }}>{line.slice(0, colonIdx)}</span>
          <span style={{ color: syntaxColors.punctuation }}>:</span>
          <span style={{ color: syntaxColors.string }}>{line.slice(colonIdx + 1)}</span>
        </>
      );
    }
    return line;
  }

  // Shell: comments and basic
  if (lang === 'shell') {
    if (line.trimStart().startsWith('#')) return <span style={{ color: syntaxColors.comment }}>{line}</span>;
    return line;
  }

  // Config files (.gitignore etc)
  if (lang === 'config') {
    if (line.trimStart().startsWith('#')) return <span style={{ color: syntaxColors.comment }}>{line}</span>;
    return line;
  }

  // Markdown: headers
  if (lang === 'markdown') {
    if (line.startsWith('#')) return <span style={{ color: syntaxColors.keyword, fontWeight: 600 }}>{line}</span>;
    return line;
  }

  return line;
}

// [pretext] renderDiffLines accepts containerWidth for zero-reflow height measurement.
// When containerWidth > 0, each line gets an explicit height computed via Canvas API
// (measureHeight) so the browser never needs to reflow text to determine row height.
export function renderDiffLines(text: string, containerWidth: number = 0) {
  // Split into hunks for collapsible rendering
  const allLines = text.split('\n');
  const hunks: { header: string; lines: string[]; startIndex: number }[] = [];
  const preamble: string[] = [];
  let currentHunk: { header: string; lines: string[]; startIndex: number } | null = null;

  allLines.forEach((line, i) => {
    if (line.startsWith('@@')) {
      if (currentHunk) hunks.push(currentHunk);
      currentHunk = { header: line, lines: [], startIndex: i + 1 };
    } else if (currentHunk) {
      currentHunk.lines.push(line);
    } else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
      preamble.push(line);
    } else {
      preamble.push(line);
    }
  });
  if (currentHunk) hunks.push(currentHunk);

  // [pretext] Fallback path — no hunks, simple line-by-line rendering.
  // When containerWidth is known, measure each line height explicitly (paddingLeft: 8 = 8px non-content).
  if (hunks.length === 0) {
    const fallbackContentWidth = containerWidth > 0 ? containerWidth - 8 : 0;
    return allLines.map((line, i) => {
      let color = 'var(--t-text)';
      let bg = 'transparent';
      if (line.startsWith('+') && !line.startsWith('+++')) { color = '#166534'; bg = 'rgba(34, 197, 94, 0.08)'; }
      else if (line.startsWith('-') && !line.startsWith('---')) { color = '#991b1b'; bg = 'rgba(239, 68, 68, 0.08)'; }
      else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) { color = 'var(--t-text-secondary)'; }
      const measuredHeight = fallbackContentWidth > 0
        ? measureHeight(line || '\u00A0', 'mono', fallbackContentWidth, 1.5, 'pre-wrap')
        : 0;
      const rowStyle: React.CSSProperties = measuredHeight > 0
        ? { color, background: bg, paddingTop: 1, paddingBottom: 1, paddingLeft: 8, height: measuredHeight, overflow: 'hidden' }
        : { color, background: bg, paddingTop: 1, paddingBottom: 1, paddingLeft: 8 };
      return <div key={i} style={rowStyle}>{line || '\u00A0'}</div>;
    });
  }

  return (
    <>
      {preamble.map((line, i) => (
        <div key={`pre-${i}`} style={{ color: 'var(--t-text-secondary)', paddingTop: 1, paddingBottom: 1, paddingLeft: 8 }}>{line || '\u00A0'}</div>
      ))}
      {hunks.map((hunk, i) => (
        <DiffHunk
          key={`hunk-${i}`}
          hunkHeader={hunk.header}
          lines={hunk.lines}
          startIndex={hunk.startIndex}
          defaultExpanded={hunks.length <= 5}
          containerWidth={containerWidth}
        />
      ))}
    </>
  );
}
