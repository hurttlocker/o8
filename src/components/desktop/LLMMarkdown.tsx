'use client';

/**
 * Rich Markdown Renderer for LLM Chat
 *
 * Handles: headings, bold, italic, code blocks (with copy + language tag),
 * inline code, blockquotes, ordered/unordered lists, tables, links,
 * images, mermaid diagrams, horizontal rules, and strikethrough.
 */

import React, { useState, useCallback, useEffect, useRef, memo } from 'react';
import { Copy, Check, ChevronDown, ChevronRight } from 'lucide-react';

// ── Code Block with copy button ──

const CodeBlock = memo(function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);
  const isMermaid = lang === 'mermaid';

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
      border: '1px solid #e2e8f0',
      background: '#f8fafc',
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
        background: '#f1f5f9',
        borderBottom: '1px solid #e2e8f0',
      }}>
        <span style={{
          fontSize: 11,
          fontWeight: 600,
          color: '#64748b',
          fontFamily: '"SF Mono", ui-monospace, monospace',
        }}>
          {lang || 'text'}
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
            color: copied ? '#10b981' : '#94a3b8',
            fontSize: 11,
            cursor: 'pointer',
            fontFamily: '-apple-system, system-ui, sans-serif',
            transition: 'color 150ms, background 150ms',
          }}
          onMouseEnter={(e) => { if (!copied) { (e.currentTarget).style.background = '#e2e8f0'; (e.currentTarget).style.color = '#475569'; } }}
          onMouseLeave={(e) => { (e.currentTarget).style.background = 'transparent'; if (!copied) (e.currentTarget).style.color = '#94a3b8'; }}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
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
        color: '#334155',
        tabSize: 2,
      }}>
        {code}
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
        const id = 'mermaid-' + Math.random().toString(36).slice(2, 8);
        const { svg: rendered } = await mermaid.render(id, code);
        if (!cancelled) setSvg(rendered);
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
      border: '1px solid #e2e8f0',
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
          background: '#f1f5f9',
          border: 'none',
          borderBottom: collapsed ? 'none' : '1px solid #e2e8f0',
          color: '#64748b',
          fontSize: 11,
          fontWeight: 600,
          cursor: 'pointer',
          fontFamily: '-apple-system, system-ui, sans-serif',
        }}
      >
        {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        Diagram
      </button>
      {!collapsed && (
        <div
          ref={containerRef}
          style={{
            paddingTop: 16,
            paddingBottom: 16,
            paddingLeft: 16,
            paddingRight: 16,
            background: 'white',
            display: 'flex',
            justifyContent: 'center',
            overflow: 'auto',
          }}
        >
          {error ? (
            <div>
              <div style={{ color: '#ef4444', fontSize: 11, marginBottom: 8, fontFamily: '-apple-system, system-ui, sans-serif' }}>⚠ Diagram syntax error — showing raw code</div>
              <pre style={{
                margin: 0,
                paddingTop: 12,
                paddingBottom: 12,
                paddingLeft: 16,
                paddingRight: 16,
                fontSize: 12,
                lineHeight: 1.5,
                fontFamily: '"SF Mono", ui-monospace, monospace',
                background: '#fef2f2',
                borderRadius: 6,
                overflowX: 'auto',
                color: '#334155',
                border: '1px solid #fecaca',
              }}>
                {code}
              </pre>
            </div>
          ) : svg ? (
            <div dangerouslySetInnerHTML={{ __html: svg }} style={{ maxWidth: '100%' }} />
          ) : (
            <div style={{ color: '#94a3b8', fontSize: 12 }}>Rendering diagram...</div>
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
        fontFamily: '-apple-system, system-ui, sans-serif',
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
                borderBottom: '2px solid #e2e8f0',
                fontWeight: 600,
                color: '#1e293b',
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
                  borderBottom: '1px solid #f1f5f9',
                  color: '#475569',
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
  // Match: **bold**, *italic*, ~~strikethrough~~, `code`, [text](url), ![alt](url)
  const regex = /(!\[([^\]]*)\]\(([^)]+)\)|\[([^\]]+)\]\(([^)]+)\)|\*\*(.+?)\*\*|\*(.+?)\*|~~(.+?)~~|`([^`]+)`)/g;
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
          style={{ color: '#3b82f6', textDecoration: 'none' }}
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
      parts.push(<s key={`s-${match.index}`} style={{ color: '#94a3b8' }}>{match[8]}</s>);
    } else if (match[9]) {
      // Inline code
      parts.push(
        <code key={`c-${match.index}`} style={{
          background: '#f1f5f9',
          paddingTop: 1,
          paddingBottom: 1,
          paddingLeft: 5,
          paddingRight: 5,
          borderRadius: 4,
          fontSize: '0.9em',
          fontFamily: '"SF Mono", ui-monospace, monospace',
          color: '#e11d48',
        }}>
          {match[9]}
        </code>
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

export function renderLLMMarkdown(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const lines = text.split('\n');
  let inCodeBlock = false;
  let codeContent = '';
  let codeLang = '';
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code block toggle
    if (line.startsWith('```')) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeLang = line.slice(3).trim();
        codeContent = '';
        i++;
        continue;
      } else {
        nodes.push(<CodeBlock key={`code-${i}`} code={codeContent} lang={codeLang} />);
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
      nodes.push(<hr key={`hr-${i}`} style={{ border: 'none', borderTop: '1px solid #e2e8f0', marginTop: 12, marginBottom: 12 }} />);
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith('> ')) {
      nodes.push(
        <div key={`q-${i}`} style={{
          borderLeft: '3px solid #3b82f6',
          paddingTop: 4,
          paddingBottom: 4,
          paddingLeft: 12,
          paddingRight: 0,
          marginTop: 4,
          marginBottom: 4,
          color: '#475569',
          background: '#f8fafc',
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
      nodes.push(<div key={`h4-${i}`} style={{ fontSize: 13, fontWeight: 600, marginTop: 12, marginBottom: 4, color: '#1e293b' }}>{renderInline(line.slice(5))}</div>);
      i++; continue;
    }
    if (line.startsWith('### ')) {
      nodes.push(<div key={`h3-${i}`} style={{ fontSize: 14, fontWeight: 600, marginTop: 14, marginBottom: 4, color: '#1e293b' }}>{renderInline(line.slice(4))}</div>);
      i++; continue;
    }
    if (line.startsWith('## ')) {
      nodes.push(<div key={`h2-${i}`} style={{ fontSize: 16, fontWeight: 600, marginTop: 16, marginBottom: 4, color: '#0f172a' }}>{renderInline(line.slice(3))}</div>);
      i++; continue;
    }
    if (line.startsWith('# ')) {
      nodes.push(<div key={`h1-${i}`} style={{ fontSize: 18, fontWeight: 700, marginTop: 18, marginBottom: 6, color: '#0f172a' }}>{renderInline(line.slice(2))}</div>);
      i++; continue;
    }

    // Ordered list
    const olMatch = line.match(/^(\d+)\.\s+(.+)/);
    if (olMatch) {
      nodes.push(
        <div key={`ol-${i}`} style={{ display: 'flex', gap: 8, marginLeft: 4, fontSize: 14, lineHeight: 1.6 }}>
          <span style={{ color: '#94a3b8', flexShrink: 0, fontWeight: 500, minWidth: 16, textAlign: 'right' }}>{olMatch[1]}.</span>
          <span>{renderInline(olMatch[2])}</span>
        </div>
      );
      i++; continue;
    }

    // Unordered list
    if (line.match(/^[-*+]\s+/)) {
      nodes.push(
        <div key={`ul-${i}`} style={{ display: 'flex', gap: 8, marginLeft: 4, fontSize: 14, lineHeight: 1.6 }}>
          <span style={{ color: '#94a3b8', flexShrink: 0 }}>•</span>
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
      <div key={`p-${i}`} style={{ fontSize: 14, lineHeight: 1.7, color: '#1e293b' }}>
        {renderInline(line)}
      </div>
    );
    i++;
  }

  // Unclosed code block
  if (inCodeBlock && codeContent) {
    nodes.push(<CodeBlock key="code-end" code={codeContent} lang={codeLang} />);
  }

  return nodes;
}
