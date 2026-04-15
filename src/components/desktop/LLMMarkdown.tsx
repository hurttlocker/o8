'use client';

/**
 * Rich Markdown Renderer for LLM Chat
 *
 * Handles: headings, bold, italic, code blocks (with copy + language tag),
 * inline code, blockquotes, ordered/unordered lists, tables, links,
 * images, mermaid diagrams, horizontal rules, and strikethrough.
 */

import React, { useState, useCallback, useEffect, useRef, useMemo, memo } from 'react';
import { Copy, Check, ChevronDown, ChevronRight, FileCode, PanelRight, Play } from './lucide-shims';
import { DiffStatusIcon } from './diff-utils';

const THEME_ACCENT = 'var(--t-accent, #2563eb)';
const THEME_ACCENT_SOFT = 'var(--t-accent-soft, rgba(37, 99, 235, 0.08))';
const THEME_ACCENT_BORDER = 'var(--t-accent-border, rgba(37, 99, 235, 0.22))';
const THEME_BG_CARD = 'var(--t-bg-card, rgba(148, 163, 184, 0.08))';
const THEME_PANEL_GLASS = 'var(--t-panel-translucent)';

// ── Syntax Highlighting ──

// Token colors tuned for the dark graphite shell while staying usable on light.
const SYN = {
  keyword: '#c792ea',
  string: '#a5d6ff',
  number: '#7cc6fe',
  comment: '#8b96a5',
  type: '#ffcb6b',
  fn: '#82aaff',
  prop: '#89ddff',
  tag: '#7ee787',
  attr: '#79c0ff',
  punct: '#d8dee9',
  builtin: '#ff7b72',
  operator: '#f78c6c',
};

function highlightCode(code: string, lang: string): React.ReactNode[] {
  const lines = code.split('\n');
  const lcLang = lang?.toLowerCase() || '';
  const isJS = ['ts', 'tsx', 'js', 'jsx', 'typescript', 'javascript'].includes(lcLang);
  const isPython = ['py', 'python'].includes(lcLang);
  const isCSS = lcLang === 'css';
  const isJSON = lcLang === 'json';
  const isShellLang = ['sh', 'bash', 'shell', 'zsh', 'console', 'terminal'].includes(lcLang);
  const isGo = lcLang === 'go';
  const isRust = lcLang === 'rust';
  const isHTML = ['html', 'xml', 'svg'].includes(lcLang);

  return lines.map((line, lineIdx) => {
    if (!line.trim()) return <React.Fragment key={lineIdx}>{'\n'}</React.Fragment>;

    const tokens: React.ReactNode[] = [];
    let remaining = line;
    let pos = 0;

    while (remaining.length > 0) {
      let matched = false;

      // Comments
      const commentMatch = remaining.match(/^(\/\/.*|#.*|\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->)/);
      if (commentMatch && (isJS || isPython || isGo || isRust || isCSS || isShellLang || isHTML)) {
        tokens.push(<span key={`${lineIdx}-${pos}`} style={{ color: SYN.comment, fontStyle: 'italic' }}>{commentMatch[0]}</span>);
        remaining = remaining.slice(commentMatch[0].length);
        pos++;
        matched = true;
        continue;
      }

      // Strings (double, single, template)
      const strMatch = remaining.match(/^("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/);
      if (strMatch) {
        tokens.push(<span key={`${lineIdx}-${pos}`} style={{ color: SYN.string }}>{strMatch[0]}</span>);
        remaining = remaining.slice(strMatch[0].length);
        pos++;
        matched = true;
        continue;
      }

      // Numbers
      const numMatch = remaining.match(/^(0x[\da-fA-F]+|0b[01]+|0o[0-7]+|\d+\.?\d*(?:[eE][+-]?\d+)?)/);
      if (numMatch && !/[a-zA-Z_]/.test(remaining[numMatch[0].length] || '')) {
        tokens.push(<span key={`${lineIdx}-${pos}`} style={{ color: SYN.number }}>{numMatch[0]}</span>);
        remaining = remaining.slice(numMatch[0].length);
        pos++;
        matched = true;
        continue;
      }

      // Keywords
      const kwPattern = isJS ? /^(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|implements|interface|type|enum|import|export|from|default|async|await|try|catch|finally|throw|typeof|instanceof|in|of|as|is|void|declare|readonly|abstract|static|public|private|protected|get|set|yield|super|constructor)\b/
        : isPython ? /^(def|class|return|if|elif|else|for|while|import|from|as|try|except|finally|raise|with|yield|lambda|pass|break|continue|and|or|not|in|is|global|nonlocal|assert|del|async|await)\b/
        : isGo ? /^(func|return|if|else|for|range|switch|case|default|break|continue|go|defer|chan|select|import|package|type|struct|interface|map|var|const|nil)\b/
        : isRust ? /^(fn|let|mut|return|if|else|for|while|loop|match|use|mod|pub|struct|enum|impl|trait|where|async|await|move|ref|self|Self|super|crate|const|static|type|as|in|unsafe|extern|dyn)\b/
        : isCSS ? /^(@media|@import|@keyframes|@font-face|@supports|!important)\b/
        : isHTML ? null
        : null;

      if (kwPattern) {
        const kwMatch = remaining.match(kwPattern);
        if (kwMatch) {
          tokens.push(<span key={`${lineIdx}-${pos}`} style={{ color: SYN.keyword, fontWeight: 600 }}>{kwMatch[0]}</span>);
          remaining = remaining.slice(kwMatch[0].length);
          pos++;
          matched = true;
          continue;
        }
      }

      // Builtins: true, false, null, undefined, this, self, None, True, False
      const builtinMatch = remaining.match(/^(true|false|null|undefined|this|self|None|True|False|NaN|Infinity)\b/);
      if (builtinMatch) {
        tokens.push(<span key={`${lineIdx}-${pos}`} style={{ color: SYN.builtin }}>{builtinMatch[0]}</span>);
        remaining = remaining.slice(builtinMatch[0].length);
        pos++;
        matched = true;
        continue;
      }

      // Type annotations (PascalCase words after : or < or extends)
      const typeMatch = remaining.match(/^([A-Z][a-zA-Z0-9_]*)\b/);
      if (typeMatch && isJS) {
        tokens.push(<span key={`${lineIdx}-${pos}`} style={{ color: SYN.type }}>{typeMatch[0]}</span>);
        remaining = remaining.slice(typeMatch[0].length);
        pos++;
        matched = true;
        continue;
      }

      // Function calls (word followed by parenthesis)
      const fnMatch = remaining.match(/^([a-zA-Z_$][\w$]*)\s*(?=\()/);
      if (fnMatch && !matched) {
        tokens.push(<span key={`${lineIdx}-${pos}`} style={{ color: SYN.fn }}>{fnMatch[1]}</span>);
        remaining = remaining.slice(fnMatch[1].length);
        pos++;
        matched = true;
        continue;
      }

      // Operators
      const opMatch = remaining.match(/^(===|!==|==|!=|<=|>=|=>|&&|\|\||\.\.\.|\?\?|[+\-*/%=<>!&|^~?:])/);
      if (opMatch) {
        tokens.push(<span key={`${lineIdx}-${pos}`} style={{ color: SYN.operator }}>{opMatch[0]}</span>);
        remaining = remaining.slice(opMatch[0].length);
        pos++;
        matched = true;
        continue;
      }

      // HTML/JSX tags
      if (isHTML || isJS) {
        const tagMatch = remaining.match(/^(<\/?[a-zA-Z][\w.-]*)/);
        if (tagMatch) {
          tokens.push(<span key={`${lineIdx}-${pos}`} style={{ color: SYN.tag }}>{tagMatch[0]}</span>);
          remaining = remaining.slice(tagMatch[0].length);
          pos++;
          matched = true;
          continue;
        }
      }

      // JSON keys
      if (isJSON) {
        const jsonKeyMatch = remaining.match(/^("[^"]*")\s*:/);
        if (jsonKeyMatch) {
          tokens.push(<span key={`${lineIdx}-${pos}`} style={{ color: SYN.prop }}>{jsonKeyMatch[1]}</span>);
          remaining = remaining.slice(jsonKeyMatch[1].length);
          pos++;
          matched = true;
          continue;
        }
      }

      if (!matched) {
        // Take one character at a time for unmatched content
        const nextSpecial = remaining.search(/[/"'`\d(A-Z]|\/\/|#|const |let |var |function |return |if |import |export |from |class |def |true|false|null|===|!==|&&|\|\|/);
        const chunk = nextSpecial > 0 ? remaining.slice(0, nextSpecial) : remaining;
        tokens.push(<span key={`${lineIdx}-${pos}`}>{chunk}</span>);
        remaining = remaining.slice(chunk.length);
        pos++;
      }
    }

    return <React.Fragment key={lineIdx}>{tokens}{'\n'}</React.Fragment>;
  });
}

// ── Code Block with copy button ──

interface DiffCardProps {
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

const DiffCard = memo(function DiffCard({ code, onApplyDiff }: DiffCardProps) {
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

const CodeBlock = memo(function CodeBlock({ code, lang, onApplyToFile, onOpenInCanvas, onRunInTerminal }: {
  code: string;
  lang: string;
  onApplyToFile?: (code: string, language: string) => void;
  onOpenInCanvas?: (code: string, language: string) => void;
  onRunInTerminal?: (command: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [applied, setApplied] = useState(false);
  const [ran, setRan] = useState(false);
  const isMermaid = lang === 'mermaid';
  const isCode = !isMermaid && (!!lang && ['ts', 'tsx', 'js', 'jsx', 'py', 'css', 'html', 'json', 'yaml', 'yml', 'toml', 'sh', 'bash', 'sql', 'go', 'rust', 'md', 'xml', 'graphql', 'typescript', 'javascript', 'python', 'ruby', 'shell', 'zsh', 'console', 'terminal', 'powershell', 'fish', 'cmd'].includes(lang.toLowerCase()));
  // Detect shell blocks: explicit tags OR untagged blocks that look like commands
  const shellTags = ['sh', 'bash', 'shell', 'zsh', 'console', 'terminal', 'powershell', 'fish', 'cmd'];
  const looksLikeShell = !lang && code.split('\n').every((line: string) => {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('$')) return true;
    return /^(npm|npx|yarn|pnpm|bun|brew|pip|cargo|go |git |cd |ls|mkdir|rm |cp |mv |cat |echo |curl |wget |docker |kubectl |sudo |apt|dnf|yum|chmod|chown|export |source |\.\/|node |python|ruby |make|cmake|gcc|g\+\+|rustc|deno|open |pbcopy|which|env |set )/.test(t);
  });
  const isShell = (!!lang && shellTags.includes(lang.toLowerCase())) || looksLikeShell;

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [code]);

  if (isMermaid) {
    return <MermaidBlock code={code} />;
  }

  return (
    <div style={{
      marginTop: 8,
      marginBottom: 8,
      borderRadius: 10,
      overflow: 'hidden',
      border: '1px solid var(--t-panel-border)',
      background: THEME_PANEL_GLASS,
    }}>
      {/* Header bar */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingTop: 4,
        paddingBottom: 4,
        paddingLeft: 12,
        paddingRight: 8,
        background: THEME_BG_CARD,
        borderBottom: '1px solid var(--t-divider)',
      }}>
        <span style={{
          fontSize: 11,
          fontWeight: 600,
          color: 'var(--t-text-secondary)',
          fontFamily: '"SF Mono", ui-monospace, monospace',
        }}>
          {lang || (isShell ? 'shell' : 'text')}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            paddingTop: 3,
            paddingBottom: 3,
            paddingLeft: 8,
            paddingRight: 8,
            border: 'none',
            borderRadius: 5,
            background: 'transparent',
            color: copied ? '#10b981' : 'var(--t-text-muted)',
            fontSize: 11,
            cursor: 'pointer',
            fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
            transition: 'color 150ms, background 150ms',
          }}
          onMouseEnter={(e) => { if (!copied) { (e.currentTarget).style.background = THEME_BG_CARD; (e.currentTarget).style.color = 'var(--t-text-secondary)'; } }}
          onMouseLeave={(e) => { (e.currentTarget).style.background = 'transparent'; if (!copied) (e.currentTarget).style.color = 'var(--t-text-muted)'; }}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? 'Copied' : 'Copy'}
        </button>

        {/* Apply to File */}
        {isCode && onApplyToFile && (
          <button
            type="button"
            onClick={() => {
              if (!applied) {
                onApplyToFile(code, lang);
                setApplied(true);
                setTimeout(() => setApplied(false), 2000);
              }
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              paddingTop: 3,
              paddingBottom: 3,
              paddingLeft: 8,
              paddingRight: 8,
              border: 'none',
              borderRadius: 5,
              background: 'transparent',
              color: applied ? '#10b981' : 'var(--t-text-muted)',
              fontSize: 11,
              cursor: 'pointer',
              fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
              transition: 'color 150ms, background 150ms',
            }}
            onMouseEnter={(e) => { if (!applied) { (e.currentTarget).style.background = THEME_BG_CARD; (e.currentTarget).style.color = THEME_ACCENT; } }}
            onMouseLeave={(e) => { (e.currentTarget).style.background = 'transparent'; if (!applied) (e.currentTarget).style.color = 'var(--t-text-muted)'; }}
          >
            {applied ? <Check size={12} /> : <FileCode size={12} />}
            {applied ? 'Applied' : 'Apply'}
          </button>
        )}

        {/* Open in Canvas */}
        {isCode && onOpenInCanvas && (
          <button
            type="button"
            onClick={() => onOpenInCanvas(code, lang)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              paddingTop: 3,
              paddingBottom: 3,
              paddingLeft: 8,
              paddingRight: 8,
              border: 'none',
              borderRadius: 5,
              background: 'transparent',
              color: 'var(--t-text-muted)',
              fontSize: 11,
              cursor: 'pointer',
              fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
              transition: 'color 150ms, background 150ms',
            }}
            onMouseEnter={(e) => { (e.currentTarget).style.background = THEME_BG_CARD; (e.currentTarget).style.color = THEME_ACCENT; }}
            onMouseLeave={(e) => { (e.currentTarget).style.background = 'transparent'; (e.currentTarget).style.color = 'var(--t-text-muted)'; }}
          >
            <PanelRight size={12} />
            Canvas
          </button>
        )}

        {/* Run in Terminal */}
        {isShell && onRunInTerminal && (
          <button
            type="button"
            onClick={() => {
              if (!ran) {
                onRunInTerminal(code);
                setRan(true);
                setTimeout(() => setRan(false), 3000);
              }
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              paddingTop: 3,
              paddingBottom: 3,
              paddingLeft: 8,
              paddingRight: 8,
              border: 'none',
              borderRadius: 5,
              background: 'transparent',
              color: ran ? '#10b981' : 'var(--t-text-muted)',
              fontSize: 11,
              cursor: 'pointer',
              fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
              transition: 'color 150ms, background 150ms',
            }}
            onMouseEnter={(e) => { if (!ran) { (e.currentTarget).style.background = 'rgba(34, 197, 94, 0.12)'; (e.currentTarget).style.color = '#4ade80'; } }}
            onMouseLeave={(e) => { (e.currentTarget).style.background = 'transparent'; if (!ran) (e.currentTarget).style.color = 'var(--t-text-muted)'; }}
          >
            {ran ? <Check size={12} /> : <Play size={12} fill="currentColor" />}
            {ran ? 'Sent' : 'Run'}
          </button>
        )}
      </div>
      {/* Code content */}
      <pre style={{
        margin: 0,
        paddingTop: 12,
        paddingBottom: 12,
        paddingLeft: 16,
        paddingRight: 16,
        fontSize: 13,
        lineHeight: 1.6,
        fontFamily: '"SF Mono", ui-monospace, "Cascadia Code", monospace',
        overflowX: 'auto',
        color: 'var(--t-text-secondary)',
        tabSize: 2,
      }}>
        {lang && !isMermaid ? highlightCode(code, lang) : code}
      </pre>
    </div>
  );
});

// ── Mermaid diagram renderer ──

const MermaidBlock = memo(function MermaidBlock({ code }: { code: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: 'loose' });
        // Render in an offscreen container to prevent DOM pollution on error
        const offscreen = document.createElement('div');
        offscreen.style.position = 'absolute';
        offscreen.style.left = '-9999px';
        offscreen.style.top = '-9999px';
        document.body.appendChild(offscreen);
        const id = 'mermaid-' + Math.random().toString(36).slice(2, 8);
        try {
          const { svg: rendered } = await mermaid.render(id, code, offscreen);
          if (!cancelled) setSvg(rendered);
        } finally {
          // Clean up offscreen container and any error elements mermaid injected
          offscreen.remove();
          // Also remove any stray mermaid error elements from the DOM
          document.querySelectorAll('[id^="d-mermaid-"], .mermaid-error, [id^="mermaid-"]').forEach(el => {
            if (el.closest('[data-llm-mermaid]')) return; // don't remove our own
            el.remove();
          });
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Render failed');
      }
    })();
    return () => { cancelled = true; };
  }, [code]);

  return (
    <div style={{
      marginTop: 8,
      marginBottom: 8,
      borderRadius: 10,
      overflow: 'hidden',
      border: '1px solid var(--t-panel-border)',
    }}>
      <button
        type="button"
        onClick={() => setCollapsed(!collapsed)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          width: '100%',
          paddingTop: 6,
          paddingBottom: 6,
          paddingLeft: 12,
          paddingRight: 12,
          background: THEME_BG_CARD,
          border: 'none',
          borderBottom: collapsed ? 'none' : '1px solid var(--t-divider)',
          color: 'var(--t-text-secondary)',
          fontSize: 11,
          fontWeight: 600,
          cursor: 'pointer',
          fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
        }}
      >
        {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        Diagram
      </button>
      {!collapsed && (
        <div
          ref={containerRef}
          data-llm-mermaid="true"
          style={{
            paddingTop: 16,
            paddingBottom: 16,
            paddingLeft: 16,
            paddingRight: 16,
            background: THEME_PANEL_GLASS,
            display: 'flex',
            justifyContent: 'center',
            overflow: 'auto',
          }}
        >
          {error ? (
            <div>
              <div style={{ color: '#ef4444', fontSize: 11, marginBottom: 8, fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif' }}>⚠ Diagram syntax error — showing raw code</div>
              <pre style={{
                margin: 0,
                paddingTop: 12,
                paddingBottom: 12,
                paddingLeft: 16,
                paddingRight: 16,
                fontSize: 12,
                lineHeight: 1.5,
                fontFamily: '"SF Mono", ui-monospace, monospace',
                background: 'rgba(127, 29, 29, 0.18)',
                borderRadius: 6,
                overflowX: 'auto',
                color: 'var(--t-text-secondary)',
                border: '1px solid rgba(239, 68, 68, 0.24)',
              }}>
                {code}
              </pre>
            </div>
          ) : svg ? (
            <div dangerouslySetInnerHTML={{ __html: svg }} style={{ maxWidth: '100%' }} />
          ) : (
            <div style={{ color: 'var(--t-text-muted)', fontSize: 12 }}>Rendering diagram...</div>
          )}
        </div>
      )}
    </div>
  );
});

// ── Table renderer ──

function renderTable(headerLine: string, alignLine: string, rows: string[]): React.ReactNode {
  const parseRow = (line: string) =>
    line.split('|').map(c => c.trim()).filter(c => c !== '');

  const headers = parseRow(headerLine);
  const aligns = parseRow(alignLine).map(a => {
    if (a.startsWith(':') && a.endsWith(':')) return 'center' as const;
    if (a.endsWith(':')) return 'right' as const;
    return 'left' as const;
  });

  return (
    <div style={{ overflowX: 'auto', marginTop: 8, marginBottom: 8 }}>
      <table style={{
        borderCollapse: 'collapse',
        fontSize: 13,
        width: '100%',
        fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
      }}>
        <thead>
          <tr>
            {headers.map((h, i) => (
              <th key={i} style={{
                paddingTop: 8,
                paddingBottom: 8,
                paddingLeft: 12,
                paddingRight: 12,
                textAlign: aligns[i] || 'left',
                borderBottom: '2px solid var(--t-divider)',
                fontWeight: 600,
                color: 'var(--t-text)',
                whiteSpace: 'nowrap',
              }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri}>
              {parseRow(row).map((cell, ci) => (
                <td key={ci} style={{
                  paddingTop: 6,
                  paddingBottom: 6,
                  paddingLeft: 12,
                  paddingRight: 12,
                  textAlign: aligns[ci] || 'left',
                  borderBottom: '1px solid var(--t-divider-subtle)',
                  color: 'var(--t-text-secondary)',
                }}>
                  {renderInline(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Inline formatting ──

function renderInline(text: string): React.ReactNode {
  if (!text) return null;

  const parts: React.ReactNode[] = [];
  // Match: **bold**, *italic*, ~~strikethrough~~, `code`, [text](url), ![alt](url), [N] citation
  const regex = /(!\[([^\]]*)\]\(([^)]+)\)|\[([^\]]+)\]\(([^)]+)\)|\*\*(.+?)\*\*|\*(.+?)\*|~~(.+?)~~|`([^`]+)`|\[(\d{1,2})\])/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text))) {
    // Text before match
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }

    if (match[3]) {
      // Image: ![alt](url)
      parts.push(
        <img
          key={`img-${match.index}`}
          src={match[3]}
          alt={match[2] || 'image'}
          style={{
            maxWidth: '100%',
            borderRadius: 8,
            marginTop: 4,
            marginBottom: 4,
            display: 'block',
          }}
        />
      );
    } else if (match[5]) {
      // Link: [text](url)
      parts.push(
        <a
          key={`a-${match.index}`}
          href={match[5]}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: THEME_ACCENT, textDecoration: 'none' }}
          onMouseEnter={(e) => { (e.currentTarget).style.textDecoration = 'underline'; }}
          onMouseLeave={(e) => { (e.currentTarget).style.textDecoration = 'none'; }}
        >
          {match[4]}
        </a>
      );
    } else if (match[6]) {
      // Bold
      parts.push(<strong key={`b-${match.index}`}>{match[6]}</strong>);
    } else if (match[7]) {
      // Italic
      parts.push(<em key={`i-${match.index}`}>{match[7]}</em>);
    } else if (match[8]) {
      // Strikethrough
      parts.push(<s key={`s-${match.index}`} style={{ color: 'var(--t-text-muted)' }}>{match[8]}</s>);
    } else if (match[9]) {
      // Inline code
      parts.push(
        <code key={`c-${match.index}`} style={{
          background: THEME_BG_CARD,
          paddingTop: 1,
          paddingBottom: 1,
          paddingLeft: 5,
          paddingRight: 5,
          borderRadius: 4,
          fontSize: '0.9em',
          fontFamily: '"SF Mono", ui-monospace, monospace',
          color: 'var(--t-text-strong)',
        }}>
          {match[9]}
        </code>
      );
    } else if (match[10]) {
      // Inline citation [N] — Perplexity style with hover card
      const num = match[10];
      parts.push(
        <span
          key={`cite-${match.index}`}
          data-citation={num}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            position: 'relative' as const,
          }}
        >
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 16,
              height: 16,
              borderRadius: '50%',
              background: THEME_ACCENT_SOFT,
              color: THEME_ACCENT,
              fontSize: 9,
              fontWeight: 700,
              cursor: 'pointer',
              verticalAlign: 'super',
              marginLeft: 1,
              marginRight: 1,
              lineHeight: 1,
              border: `1px solid ${THEME_ACCENT_BORDER}`,
              transition: 'all 100ms',
              position: 'relative' as const,
              top: -4,
            }}
            onMouseEnter={(e) => {
              (e.currentTarget).style.background = THEME_ACCENT;
              (e.currentTarget).style.color = 'white';
              (e.currentTarget).style.borderColor = THEME_ACCENT;
              // Show tooltip
              const tooltip = (e.currentTarget.parentElement as HTMLElement)?.querySelector('[data-cite-tooltip]') as HTMLElement;
              if (tooltip) tooltip.style.display = 'block';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget).style.background = THEME_ACCENT_SOFT;
              (e.currentTarget).style.color = THEME_ACCENT;
              (e.currentTarget).style.borderColor = THEME_ACCENT_BORDER;
              const tooltip = (e.currentTarget.parentElement as HTMLElement)?.querySelector('[data-cite-tooltip]') as HTMLElement;
              if (tooltip) tooltip.style.display = 'none';
            }}
          >
            {num}
          </span>
          <span
            data-cite-tooltip="true"
            style={{
              display: 'none',
              position: 'absolute' as const,
              bottom: '100%',
              left: '50%',
              transform: 'translateX(-50%)',
              marginBottom: 6,
              paddingTop: 6,
              paddingBottom: 6,
              paddingLeft: 10,
              paddingRight: 10,
              background: THEME_PANEL_GLASS,
              border: '1px solid var(--t-panel-border)',
              borderRadius: 8,
              boxShadow: 'var(--t-panel-shadow)',
              fontSize: 11,
              color: 'var(--t-text-secondary)',
              whiteSpace: 'nowrap' as const,
              zIndex: 50,
              pointerEvents: 'none' as const,
            }}
          >
            Source {num}
          </span>
        </span>
      );
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts.length === 1 ? parts[0] : <>{parts}</>;
}

// ── Main markdown renderer ──

export function renderLLMMarkdown(text: string, opts?: {
  onApplyToFile?: (code: string, language: string) => void;
  onOpenInCanvas?: (code: string, language: string) => void;
  onRunInTerminal?: (command: string) => void;
  onApplyDiff?: (diffText: string) => void;
}): React.ReactNode[] {
  // Handle <think>...</think> blocks — render as italic, smaller, muted text
  const processedText = text.replace(/<think>([\s\S]*?)(<\/think>|$)/g, (_match, content, closer) => {
    const isUnclosed = closer !== '</think>';
    // Convert to a special marker we'll detect below
    return `\n%%THINK_START%%\n${content.trim()}${isUnclosed ? '\n%%THINK_STREAMING%%' : ''}\n%%THINK_END%%\n`;
  });

  const nodes: React.ReactNode[] = [];
  const lines = processedText.split('\n');
  let inCodeBlock = false;
  let codeContent = '';
  let codeLang = '';
  let inThinking = false;
  let thinkingContent = '';
  let thinkingStreaming = false;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Thinking block markers
    if (line === '%%THINK_START%%') {
      inThinking = true;
      thinkingContent = '';
      thinkingStreaming = false;
      i++;
      continue;
    }
    if (line === '%%THINK_STREAMING%%') {
      thinkingStreaming = true;
      i++;
      continue;
    }
    if (line === '%%THINK_END%%') {
      if (thinkingContent.trim()) {
        nodes.push(
          <div key={`think-${i}`} style={{
            fontSize: 12,
            fontStyle: 'italic',
            color: 'var(--t-text-muted)',
            lineHeight: 1.5,
            paddingTop: 6,
            paddingBottom: 6,
            paddingLeft: 12,
            borderLeft: '2px solid var(--t-divider)',
            marginTop: 4,
            marginBottom: 8,
            animation: 'llmFadeIn 200ms ease-out',
          }}>
            {thinkingContent.split('\n').map((tLine, tIdx) => (
              <React.Fragment key={tIdx}>
                {tLine}
                {tIdx < thinkingContent.split('\n').length - 1 && <br />}
              </React.Fragment>
            ))}
            {thinkingStreaming && (
              <span style={{
                display: 'inline-block',
                width: 2,
                height: 12,
                background: 'var(--t-text-muted)',
                marginLeft: 2,
                verticalAlign: 'text-bottom',
                animation: 'llmDot 1s ease-in-out infinite',
              }} />
            )}
          </div>
        );
      }
      inThinking = false;
      thinkingContent = '';
      i++;
      continue;
    }
    if (inThinking) {
      thinkingContent += (thinkingContent ? '\n' : '') + line;
      i++;
      continue;
    }

    // Code block toggle
    if (line.startsWith('```')) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeLang = line.slice(3).trim();
        codeContent = '';
        i++;
        continue;
      } else {
        if (codeLang.toLowerCase() === 'diff') {
          nodes.push(<DiffCard key={`diff-${i}`} code={codeContent} onApplyDiff={opts?.onApplyDiff} />);
        } else {
          nodes.push(<CodeBlock key={`code-${i}`} code={codeContent} lang={codeLang} onApplyToFile={opts?.onApplyToFile} onOpenInCanvas={opts?.onOpenInCanvas} onRunInTerminal={opts?.onRunInTerminal} />);
        }
        inCodeBlock = false;
        codeContent = '';
        codeLang = '';
        i++;
        continue;
      }
    }

    if (inCodeBlock) {
      codeContent += (codeContent ? '\n' : '') + line;
      i++;
      continue;
    }

    // Table detection: line with |, next line with |---|
    if (line.includes('|') && i + 1 < lines.length && /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?$/.test(lines[i + 1])) {
      const headerLine = line;
      const alignLine = lines[i + 1];
      const tableRows: string[] = [];
      let j = i + 2;
      while (j < lines.length && lines[j].includes('|')) {
        tableRows.push(lines[j]);
        j++;
      }
      nodes.push(<React.Fragment key={`table-${i}`}>{renderTable(headerLine, alignLine, tableRows)}</React.Fragment>);
      i = j;
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      nodes.push(<hr key={`hr-${i}`} style={{ border: 'none', borderTop: '1px solid var(--t-divider)', marginTop: 12, marginBottom: 12 }} />);
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith('> ')) {
      nodes.push(
        <div key={`q-${i}`} style={{
          borderLeft: `3px solid ${THEME_ACCENT}`,
          paddingTop: 4,
          paddingBottom: 4,
          paddingLeft: 12,
          paddingRight: 0,
          marginTop: 4,
          marginBottom: 4,
          color: 'var(--t-text-secondary)',
          background: THEME_BG_CARD,
          borderRadius: '0 6px 6px 0',
          fontSize: 13,
          lineHeight: 1.5,
        }}>
          {renderInline(line.slice(2))}
        </div>
      );
      i++;
      continue;
    }

    // Headings
    if (line.startsWith('#### ')) {
      nodes.push(<div key={`h4-${i}`} style={{ fontSize: 13, fontWeight: 600, marginTop: 12, marginBottom: 4, color: 'var(--t-text)' }}>{renderInline(line.slice(5))}</div>);
      i++; continue;
    }
    if (line.startsWith('### ')) {
      nodes.push(<div key={`h3-${i}`} style={{ fontSize: 14, fontWeight: 600, marginTop: 14, marginBottom: 4, color: 'var(--t-text)' }}>{renderInline(line.slice(4))}</div>);
      i++; continue;
    }
    if (line.startsWith('## ')) {
      nodes.push(<div key={`h2-${i}`} style={{ fontSize: 16, fontWeight: 600, marginTop: 16, marginBottom: 4, color: 'var(--t-text-strong)' }}>{renderInline(line.slice(3))}</div>);
      i++; continue;
    }
    if (line.startsWith('# ')) {
      nodes.push(<div key={`h1-${i}`} style={{ fontSize: 18, fontWeight: 700, marginTop: 18, marginBottom: 6, color: 'var(--t-text-strong)' }}>{renderInline(line.slice(2))}</div>);
      i++; continue;
    }

    // Ordered list
    const olMatch = line.match(/^(\d+)\.\s+(.+)/);
    if (olMatch) {
      nodes.push(
        <div key={`ol-${i}`} style={{ display: 'flex', gap: 8, marginLeft: 4, fontSize: 14, lineHeight: 1.6 }}>
          <span style={{ color: 'var(--t-text-muted)', flexShrink: 0, fontWeight: 500, minWidth: 16, textAlign: 'right' }}>{olMatch[1]}.</span>
          <span>{renderInline(olMatch[2])}</span>
        </div>
      );
      i++; continue;
    }

    // Unordered list
    if (line.match(/^[-*+]\s+/)) {
      nodes.push(
        <div key={`ul-${i}`} style={{ display: 'flex', gap: 8, marginLeft: 4, fontSize: 14, lineHeight: 1.6 }}>
          <span style={{ color: 'var(--t-text-muted)', flexShrink: 0 }}>•</span>
          <span>{renderInline(line.replace(/^[-*+]\s+/, ''))}</span>
        </div>
      );
      i++; continue;
    }

    // Empty line
    if (!line.trim()) {
      nodes.push(<div key={`br-${i}`} style={{ height: 8 }} />);
      i++; continue;
    }

    // Regular paragraph
    nodes.push(
      <div key={`p-${i}`} style={{ fontSize: 14, lineHeight: 1.7, color: 'var(--t-text)' }}>
        {renderInline(line)}
      </div>
    );
    i++;
  }

  // Unclosed code block — streaming mode (show live with cursor)
  if (inCodeBlock && codeContent) {
    nodes.push(
      <div key="code-streaming" style={{
        marginTop: 8,
        marginBottom: 8,
        borderRadius: 10,
        overflow: 'hidden',
        border: '1px solid var(--t-panel-border)',
        background: THEME_PANEL_GLASS,
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingTop: 4,
          paddingBottom: 4,
          paddingLeft: 12,
          paddingRight: 8,
          background: THEME_BG_CARD,
          borderBottom: '1px solid var(--t-divider)',
        }}>
          <span style={{
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--t-text-secondary)',
            fontFamily: '"SF Mono", ui-monospace, monospace',
          }}>
            {codeLang || 'code'}
          </span>
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 10,
            color: THEME_ACCENT,
            fontWeight: 500,
          }}>
            <span style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: THEME_ACCENT,
              animation: 'llmDot 1s ease-in-out infinite',
            }} />
            streaming
          </span>
        </div>
        <pre style={{
          margin: 0,
          paddingTop: 12,
          paddingBottom: 12,
          paddingLeft: 16,
          paddingRight: 16,
          fontSize: 13,
          lineHeight: 1.6,
          fontFamily: '"SF Mono", ui-monospace, "Cascadia Code", monospace',
          overflowX: 'auto',
          color: 'var(--t-text-secondary)',
          tabSize: 2,
        }}>
          {codeLang ? highlightCode(codeContent, codeLang) : codeContent}
          <span style={{
            display: 'inline-block',
            width: 2,
            height: 16,
            background: THEME_ACCENT,
            marginLeft: 1,
            verticalAlign: 'text-bottom',
            animation: 'llmDot 1s ease-in-out infinite',
          }} />
        </pre>
      </div>
    );
  }

  return nodes;
}
