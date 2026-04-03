'use client';
/* eslint-disable @next/next/no-img-element -- lightweight markdown renderer needs raw img support */

import { Fragment, useState, type CSSProperties, type ReactNode } from 'react';

type MarkdownBlock =
  | { type: 'code'; code: string; language: string }
  | { type: 'heading'; level: 1 | 2 | 3 | 4; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'blockquote'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] };

export type HighlightToken = { type: 'plain' | 'keyword' | 'string' | 'number' | 'comment' | 'function'; value: string };

const KEYWORDS = new Set([
  'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'delete',
  'do', 'else', 'export', 'extends', 'false', 'finally', 'for', 'from', 'function', 'if', 'import', 'in',
  'instanceof', 'interface', 'let', 'new', 'null', 'of', 'return', 'static', 'super', 'switch', 'this',
  'throw', 'true', 'try', 'type', 'typeof', 'var', 'void', 'while', 'with', 'yield',
]);

function inlineCodeStyle(textColor: string): CSSProperties {
  return {
    backgroundColor: 'rgba(128,128,128,0.12)',
    borderRadius: 7,
    color: textColor,
    fontFamily: '"SF Mono", Menlo, monospace',
    fontSize: '0.92em',
    padding: '0.18em 0.42em',
  };
}

// Strip emoji characters from LLM responses — we use Phosphor icons, not emoji
const EMOJI_REGEX = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1FA00}-\u{1FA9F}\u{200D}]/gu;
function stripEmoji(text: string): string {
  return text.replace(EMOJI_REGEX, '').replace(/^\s+/, '');
}

function tokenizeCodeLine(line: string, inBlockComment: boolean) {
  const tokens: HighlightToken[] = [];
  let cursor = 0;
  let nextInBlockComment = inBlockComment;

  const push = (type: HighlightToken['type'], value: string) => {
    if (value) tokens.push({ type, value });
  };

  while (cursor < line.length) {
    if (nextInBlockComment) {
      const end = line.indexOf('*/', cursor);
      if (end === -1) {
        push('comment', line.slice(cursor));
        return { tokens, inBlockComment: true };
      }
      push('comment', line.slice(cursor, end + 2));
      cursor = end + 2;
      nextInBlockComment = false;
      continue;
    }

    const rest = line.slice(cursor);
    if (rest.startsWith('//')) {
      push('comment', rest);
      break;
    }
    if (rest.startsWith('/*')) {
      const end = line.indexOf('*/', cursor + 2);
      if (end === -1) {
        push('comment', rest);
        return { tokens, inBlockComment: true };
      }
      push('comment', line.slice(cursor, end + 2));
      cursor = end + 2;
      continue;
    }

    const char = line[cursor];
    if (char === '"' || char === '\'') {
      let end = cursor + 1;
      while (end < line.length) {
        if (line[end] === '\\') {
          end += 2;
          continue;
        }
        if (line[end] === char) {
          end += 1;
          break;
        }
        end += 1;
      }
      push('string', line.slice(cursor, end));
      cursor = end;
      continue;
    }

    if (/\d/.test(char)) {
      let end = cursor + 1;
      while (end < line.length && /[\d._xXa-fA-F]/.test(line[end])) end += 1;
      push('number', line.slice(cursor, end));
      cursor = end;
      continue;
    }

    if (/[A-Za-z_$]/.test(char)) {
      let end = cursor + 1;
      while (end < line.length && /[\w$]/.test(line[end])) end += 1;
      const word = line.slice(cursor, end);
      const trailing = line.slice(end);
      if (KEYWORDS.has(word)) {
        push('keyword', word);
      } else if (/^\s*\(/.test(trailing)) {
        push('function', word);
      } else {
        push('plain', word);
      }
      cursor = end;
      continue;
    }

    push('plain', char);
    cursor += 1;
  }

  return { tokens, inBlockComment: nextInBlockComment };
}

function renderInline(text: string, keyPrefix = 'inline', textColor = '#e5e7eb'): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /!\[([^\]]*)\]\(([^)]+)\)|\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`|\*\*([\s\S]+?)\*\*|\*([^*\n]+)\*/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(stripEmoji(text.slice(lastIndex, match.index)));
    }

    const key = `${keyPrefix}-${match.index}`;
    if (match[1] !== undefined) {
      nodes.push(
        <img
          key={key}
          src={match[2]}
          alt={match[1]}
          style={{
            display: 'block',
            maxWidth: '100%',
            borderRadius: 10,
            marginTop: 10,
            marginBottom: 6,
          }}
        />,
      );
    } else if (match[3] !== undefined) {
      nodes.push(
        <a
          key={key}
          href={match[4]}
          target="_blank"
          rel="noreferrer"
          style={{ color: '#60a5fa', textDecoration: 'none' }}
        >
          {renderInline(match[3], `${key}-link`, textColor)}
        </a>,
      );
    } else if (match[5] !== undefined) {
      nodes.push(
        <code key={key} style={inlineCodeStyle(textColor)}>
          {match[5]}
        </code>,
      );
    } else if (match[6] !== undefined) {
      nodes.push(
        <strong key={key} style={{ color: textColor, fontWeight: 600 }}>
          {renderInline(match[6], `${key}-bold`, textColor)}
        </strong>,
      );
    } else if (match[7] !== undefined) {
      nodes.push(
        <em key={key} style={{ color: textColor, fontStyle: 'italic', opacity: 0.82 }}>
          {renderInline(match[7], `${key}-italic`, textColor)}
        </em>,
      );
    }

    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) {
    nodes.push(stripEmoji(text.slice(lastIndex)));
  }

  return nodes;
}

function isListLine(line: string, ordered: boolean) {
  return ordered ? /^\s*\d+\.\s+/.test(line) : /^\s*[-*]\s+/.test(line);
}

function isBlockStart(line: string) {
  return /^```/.test(line)
    || /^#{1,4}\s+/.test(line)
    || /^>\s?/.test(line)
    || isListLine(line, false)
    || isListLine(line, true);
}

function parseBlocks(content: string): MarkdownBlock[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const codeMatch = line.match(/^```([\w-]+)?\s*$/);
    if (codeMatch) {
      const fenceLanguage = codeMatch[1]?.toLowerCase() ?? '';
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: 'code', code: codeLines.join('\n'), language: fenceLanguage || 'text' });
      continue;
    }

    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      blocks.push({
        type: 'heading',
        level: headingMatch[1].length as 1 | 2 | 3 | 4,
        text: headingMatch[2].trim(),
      });
      index += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length && (lines[index].trim() === '' || /^>\s?/.test(lines[index]))) {
        quoteLines.push(lines[index].replace(/^>\s?/, ''));
        index += 1;
      }
      blocks.push({ type: 'blockquote', text: quoteLines.join('\n').trim() });
      continue;
    }

    if (isListLine(line, false) || isListLine(line, true)) {
      const ordered = isListLine(line, true);
      const items: string[] = [];
      while (index < lines.length && isListLine(lines[index], ordered)) {
        items.push(lines[index].replace(ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/, '').trim());
        index += 1;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    const paragraphLines = [line.trim()];
    index += 1;
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index])) {
      paragraphLines.push(lines[index].trim());
      index += 1;
    }
    blocks.push({ type: 'paragraph', text: paragraphLines.join(' ') });
  }

  return blocks;
}

export function highlightCode(code: string) {
  const highlightedLines: Array<{ tokens: HighlightToken[] }> = [];
  let inBlockComment = false;

  for (const line of code.split('\n')) {
    const result = tokenizeCodeLine(line, inBlockComment);
    highlightedLines.push({ tokens: result.tokens });
    inBlockComment = result.inBlockComment;
  }

  return highlightedLines;
}

function isDiffBlock(code: string): boolean {
  const lines = code.split('\n');
  let diffLines = 0;
  for (const line of lines) {
    if (line.startsWith('+') || line.startsWith('-') || line.startsWith('@@') || line.startsWith('diff ')) {
      diffLines += 1;
    }
  }
  return diffLines > lines.length * 0.25;
}

function extractFileLabel(language: string, code: string): string | null {
  // Check language tag for file path
  const langParts = language.split(/\s+/);
  for (const part of langParts) {
    if (part.includes('/') && part.includes('.')) return part;
  }
  // Check first line of diff for file path
  const firstLine = code.split('\n')[0] ?? '';
  const diffFileMatch = firstLine.match(/^(?:diff --git a\/|---|\+\+\+)\s*(.+?)(?:\s|$)/);
  if (diffFileMatch?.[1]) return diffFileMatch[1].replace(/^[ab]\//, '');
  return null;
}

export function codeTheme(light: boolean) {
  return light ? {
    bg: '#f8f9fc',
    border: 'rgba(0,0,0,0.08)',
    headerColor: '#6b7280',
    headerBorder: 'rgba(0,0,0,0.06)',
    text: '#24292f',
    shadow: '0 2px 8px rgba(0,0,0,0.06)',
    keyword: '#8250df',
    string: '#0a3069',
    number: '#0550ae',
    comment: '#6e7781',
    fn: '#8250df',
    diffAdd: 'rgba(34,197,94,0.12)',
    diffDel: 'rgba(239,68,68,0.1)',
    diffHunk: 'rgba(96,165,250,0.08)',
    diffAddColor: '#116329',
    diffDelColor: '#cf222e',
    diffHunkColor: '#0550ae',
    copiedBg: 'rgba(37,99,235,0.1)',
    copiedColor: '#2563eb',
    btnColor: '#6b7280',
  } : {
    bg: '#1e1e2e',
    border: 'rgba(148,163,184,0.16)',
    headerColor: '#8b96a5',
    headerBorder: 'rgba(148,163,184,0.12)',
    text: '#dbe4f0',
    shadow: '0 10px 30px rgba(0,0,0,0.24)',
    keyword: '#c792ea',
    string: '#a5d6ff',
    number: '#7cc6fe',
    comment: '#8b96a5',
    fn: '#82aaff',
    diffAdd: 'rgba(34,197,94,0.1)',
    diffDel: 'rgba(239,68,68,0.1)',
    diffHunk: 'rgba(96,165,250,0.06)',
    diffAddColor: '#86efac',
    diffDelColor: '#fca5a5',
    diffHunkColor: '#93c5fd',
    copiedBg: 'rgba(96,165,250,0.14)',
    copiedColor: '#bfdbfe',
    btnColor: '#94a3b8',
  };
}

function CodeBlock({ code, language, light }: { code: string; language: string; light: boolean }) {
  const [copied, setCopied] = useState(false);
  const isDiff = isDiffBlock(code) || language === 'diff';
  const fileLabel = extractFileLabel(language, code);
  const [collapsed, setCollapsed] = useState(isDiff && code.split('\n').length > 8);
  const highlightedLines = highlightCode(code);
  const t = codeTheme(light);

  return (
    <div
      style={{
        marginTop: 12,
        marginBottom: 14,
        borderRadius: 14,
        overflow: 'hidden',
        border: `1px solid ${t.border}`,
        backgroundColor: t.bg,
        boxShadow: t.shadow,
      }}
    >
      <div
        style={{
          alignItems: 'center',
          borderBottom: `1px solid ${t.headerBorder}`,
          color: t.headerColor,
          display: 'flex',
          fontFamily: '"SF Mono", Menlo, monospace',
          fontSize: 11,
          fontWeight: 600,
          justifyContent: 'space-between',
          letterSpacing: '0.04em',
          padding: '10px 12px',
          textTransform: 'lowercase',
        }}
      >
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          style={{ display: 'flex', alignItems: 'center', gap: 6, border: 'none', backgroundColor: 'transparent', color: t.headerColor, cursor: 'pointer', padding: 0, fontFamily: '"SF Mono", Menlo, monospace', fontSize: 11, fontWeight: 600, letterSpacing: '0.04em' }}
        >
          <svg width="12" height="12" viewBox="0 0 256 256" fill={t.headerColor} style={{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform 0.2s ease' }}>
            <path d="M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80A8,8,0,0,1,53.66,90.34L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z" />
          </svg>
          <span>{fileLabel ?? language}</span>
        </button>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(code).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1800);
            }).catch(() => undefined);
          }}
          style={{
            alignItems: 'center',
            backgroundColor: copied ? t.copiedBg : 'transparent',
            border: 'none',
            borderRadius: 999,
            color: copied ? t.copiedColor : t.btnColor,
            cursor: 'pointer',
            display: 'inline-flex',
            gap: 6,
            padding: '4px 8px',
          }}
          aria-label={copied ? 'Copied code block' : 'Copy code block'}
        >
          <svg width="14" height="14" viewBox="0 0 256 256" fill={copied ? t.copiedColor : t.btnColor} aria-hidden="true">
            <path d="M196,64V192a12,12,0,0,1-12,12H88a12,12,0,0,1-12-12V64A12,12,0,0,1,88,52h96A12,12,0,0,1,196,64Zm-12,0H88V192h96ZM52,176a6,6,0,0,1-12,0V88A20,20,0,0,1,60,68h88a6,6,0,0,1,0,12H60a8,8,0,0,0-8,8Z" />
          </svg>
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      {!collapsed && (
      <pre
        style={{
          color: t.text,
          fontFamily: '"SF Mono", Menlo, monospace',
          fontSize: 13,
          lineHeight: 1.65,
          margin: 0,
          overflowX: 'auto',
          padding: '14px 16px 16px',
          whiteSpace: 'pre',
        }}
      >
        {highlightedLines.map((line, lineIndex) => {
          const rawLine = code.split('\n')[lineIndex] ?? '';
          const isAddition = isDiff && rawLine.startsWith('+') && !rawLine.startsWith('+++');
          const isDeletion = isDiff && rawLine.startsWith('-') && !rawLine.startsWith('---');
          const isHunk = isDiff && rawLine.startsWith('@@');
          const diffBg = isAddition ? t.diffAdd : isDeletion ? t.diffDel : isHunk ? t.diffHunk : undefined;
          const diffColor = isAddition ? t.diffAddColor : isDeletion ? t.diffDelColor : isHunk ? t.diffHunkColor : undefined;

          return (
            <Fragment key={`${language}-${lineIndex}`}>
              <span style={diffBg ? { backgroundColor: diffBg, display: 'inline-block', width: '100%', marginLeft: -16, marginRight: -16, paddingLeft: 16, paddingRight: 16 } : undefined}>
              {line.tokens.map((token, tokenIndex) => (
                <span
                  key={`${language}-${lineIndex}-${tokenIndex}`}
                  style={{
                    color: diffColor ?? (token.type === 'keyword'
                      ? t.keyword
                      : token.type === 'string'
                        ? t.string
                        : token.type === 'number'
                          ? t.number
                          : token.type === 'comment'
                            ? t.comment
                            : token.type === 'function'
                              ? t.fn
                              : t.text),
                  }}
                >
                  {token.value}
                </span>
              ))}
              </span>
              {lineIndex < highlightedLines.length - 1 ? '\n' : null}
            </Fragment>
          );
        })}
      </pre>
      )}
    </div>
  );
}

export function MobileMarkdown({ content, textColor, light }: { content: string; textColor?: string; light?: boolean }) {
  const blocks = parseBlocks(content);
  const baseColor = textColor ?? '#e5e7eb';
  const isLight = light ?? false;

  return (
    <div style={{ color: baseColor, fontSize: 15, lineHeight: 1.6, wordBreak: 'break-word' }}>
      {blocks.map((block, index) => {
        if (block.type === 'code') {
          return <CodeBlock key={`code-${index}`} code={block.code} language={block.language} light={isLight} />;
        }

        if (block.type === 'heading') {
          const sizes = { 1: 28, 2: 24, 3: 20, 4: 17 } as const;
          return (
            <div
              key={`heading-${index}`}
              style={{
                color: baseColor,
                fontSize: sizes[block.level],
                fontWeight: 700,
                letterSpacing: '-0.03em',
                lineHeight: 1.2,
                marginTop: index === 0 ? 0 : 18,
                marginBottom: 10,
              }}
            >
              {renderInline(stripEmoji(block.text), `heading-${index}`, baseColor)}
            </div>
          );
        }

        if (block.type === 'blockquote') {
          const quoteParagraphs = block.text.split(/\n{2,}/).filter(Boolean);
          return (
            <div
              key={`quote-${index}`}
              style={{
                borderLeft: '3px solid rgba(96,165,250,0.75)',
                color: '#94a3b8',
                marginTop: 10,
                marginBottom: 14,
                paddingLeft: 14,
              }}
            >
              {quoteParagraphs.map((paragraph, paragraphIndex) => (
                <div key={`quote-${index}-${paragraphIndex}`} style={{ marginBottom: paragraphIndex === quoteParagraphs.length - 1 ? 0 : 10 }}>
                  {renderInline(paragraph.replace(/\n/g, ' '), `quote-${index}-${paragraphIndex}`, baseColor)}
                </div>
              ))}
            </div>
          );
        }

        if (block.type === 'list') {
          const ListTag = block.ordered ? 'ol' : 'ul';
          return (
            <ListTag
              key={`list-${index}`}
              style={{
                color: baseColor,
                marginTop: 8,
                marginBottom: 14,
                paddingLeft: 22,
              }}
            >
              {block.items.map((item, itemIndex) => (
                <li key={`list-${index}-${itemIndex}`} style={{ marginBottom: 8, paddingLeft: 4 }}>
                  {renderInline(stripEmoji(item), `list-${index}-${itemIndex}`, baseColor)}
                </li>
              ))}
            </ListTag>
          );
        }

        return (
          <p key={`paragraph-${index}`} style={{ marginTop: 0, marginBottom: 14 }}>
            {renderInline(stripEmoji(block.text), `paragraph-${index}`, baseColor)}
          </p>
        );
      })}
    </div>
  );
}
