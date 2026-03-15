'use client';

/**
 * MarkdownBody — renders markdown text with proper formatting.
 *
 * Handles: headings, code blocks (with mermaid), lists, tables, blockquotes,
 * horizontal rules, numbered lists, inline code, bold, links, images.
 *
 * Reuses the same CodeBlock component (with mermaid support) as the chat.
 */

import React, { memo, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { CodeBlock } from './CodeBlock';

// ── Image URL resolver ──

function resolveImageSrc(src: string): string {
  // Already an HTTP URL or data URL
  if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:')) return src;
  // Local file path — serve through our API
  return `/api/panel/serve-image?path=${encodeURIComponent(src)}`;
}

// ── Image Lightbox Modal ──

function ImageLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 99999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0, 0, 0, 0.75)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        cursor: 'zoom-out',
      }}
    >
      <button
        type="button"
        onClick={onClose}
        style={{
          position: 'absolute',
          top: 16,
          right: 16,
          width: 36,
          height: 36,
          borderRadius: 18,
          border: 'none',
          background: 'rgba(255,255,255,0.15)',
          color: '#ffffff',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 100000,
        }}
      >
        <X size={18} strokeWidth={2} />
      </button>
      <img
        src={src}
        alt={alt}
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: '92vw',
          maxHeight: '90vh',
          objectFit: 'contain',
          borderRadius: 8,
          boxShadow: '0 8px 40px rgba(0,0,0,0.4)',
          cursor: 'default',
        }}
      />
    </div>,
    document.body
  );
}

// ── Inline Image ──

function InlineImage({ src, alt }: { src: string; alt: string }) {
  const [lightbox, setLightbox] = useState(false);
  const resolved = resolveImageSrc(src);

  return (
    <>
      <img
        src={resolved}
        alt={alt}
        onClick={() => setLightbox(true)}
        style={{
          maxWidth: '100%',
          maxHeight: 400,
          borderRadius: 10,
          marginTop: 8,
          marginBottom: 8,
          cursor: 'zoom-in',
          boxShadow: '0 2px 12px rgba(0,0,0,0.08)',
          border: '1px solid rgba(0,0,0,0.06)',
          display: 'block',
        }}
      />
      {lightbox && <ImageLightbox src={resolved} alt={alt} onClose={() => setLightbox(false)} />}
    </>
  );
}

// ── Inline rendering ──

function renderInline(text: string): React.ReactNode {
  // Handle images, bold, inline code, and links
  const parts = text.split(/(!\[[^\]]*\]\([^)]+\)|`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g);
  return parts.map((part, i) => {
    // Images: ![alt](url)
    const imgMatch = part.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (imgMatch) {
      return <InlineImage key={i} alt={imgMatch[1]} src={imgMatch[2]} />;
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <code key={i} style={{
          background: 'rgba(0,0,0,0.05)',
          paddingTop: 1,
          paddingRight: 5,
          paddingBottom: 1,
          paddingLeft: 5,
          borderRadius: 4,
          fontSize: '0.85em',
          fontFamily: '"SF Mono", ui-monospace, monospace',
          color: '#d946ef',
        }}>
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i} style={{ fontWeight: 600 }}>{part.slice(2, -2)}</strong>;
    }
    // Links: [text](url)
    const linkMatch = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (linkMatch) {
      return (
        <a
          key={i}
          href={linkMatch[2]}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: '#2563eb', textDecoration: 'none', borderBottom: '1px solid rgba(37,99,235,0.3)' }}
        >
          {linkMatch[1]}
        </a>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

// ── Block rendering ──

interface MarkdownBodyProps {
  text: string;
}

export const MarkdownBody = memo(function MarkdownBody({ text }: MarkdownBodyProps) {
  const lines = text.split('\n');
  const elements: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code blocks
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      elements.push(
        <CodeBlock key={key++} code={codeLines.join('\n')} language={lang || undefined} />
      );
      continue;
    }

    // Headings
    if (line.startsWith('### ')) {
      elements.push(
        <h4 key={key++} style={{
          fontSize: '0.95rem',
          fontWeight: 700,
          color: '#0f172a',
          marginTop: 20,
          marginBottom: 8,
          letterSpacing: '-0.01em',
        }}>
          {renderInline(line.slice(4))}
        </h4>
      );
      i++;
      continue;
    }
    if (line.startsWith('## ')) {
      elements.push(
        <h3 key={key++} style={{
          fontSize: '1.05rem',
          fontWeight: 700,
          color: '#0f172a',
          marginTop: 24,
          marginBottom: 10,
          letterSpacing: '-0.01em',
        }}>
          {renderInline(line.slice(3))}
        </h3>
      );
      i++;
      continue;
    }
    if (line.startsWith('# ')) {
      elements.push(
        <h2 key={key++} style={{
          fontSize: '1.2rem',
          fontWeight: 700,
          color: '#0f172a',
          marginTop: 28,
          marginBottom: 12,
          letterSpacing: '-0.02em',
        }}>
          {renderInline(line.slice(2))}
        </h2>
      );
      i++;
      continue;
    }

    // Horizontal rule
    if (/^[-*_]{3,}\s*$/.test(line.trim())) {
      elements.push(
        <hr key={key++} style={{
          border: 'none',
          borderTop: '1px solid rgba(0,0,0,0.08)',
          marginTop: 16,
          marginBottom: 16,
        }} />
      );
      i++;
      continue;
    }

    // Blockquotes
    if (line.startsWith('> ')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].startsWith('> ')) {
        quoteLines.push(lines[i].slice(2));
        i++;
      }
      elements.push(
        <blockquote key={key++} style={{
          margin: '12px 0',
          paddingTop: 8,
          paddingRight: 16,
          paddingBottom: 8,
          paddingLeft: 16,
          borderLeft: '3px solid #ef4444',
          background: 'rgba(239, 68, 68, 0.04)',
          borderRadius: '0 8px 8px 0',
          color: '#475569',
          fontSize: '0.9rem',
          lineHeight: 1.6,
        }}>
          {quoteLines.map((ql, qi) => (
            <div key={qi}>{renderInline(ql)}</div>
          ))}
        </blockquote>
      );
      continue;
    }

    // Unordered lists
    if (line.startsWith('- ') || line.startsWith('* ')) {
      const items: { text: string; idx: number }[] = [];
      while (i < lines.length && (lines[i].startsWith('- ') || lines[i].startsWith('* '))) {
        items.push({ text: lines[i].slice(2), idx: i });
        i++;
      }
      elements.push(
        <ul key={key++} style={{
          margin: '8px 0',
          paddingLeft: 20,
          fontSize: '0.9rem',
          lineHeight: 1.7,
          color: '#1e293b',
        }}>
          {items.map((item) => (
            <li key={item.idx} style={{ marginBottom: 3 }}>{renderInline(item.text)}</li>
          ))}
        </ul>
      );
      continue;
    }

    // Numbered lists
    if (/^\d+\.\s/.test(line)) {
      const items: { text: string; idx: number }[] = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
        items.push({ text: lines[i].replace(/^\d+\.\s/, ''), idx: i });
        i++;
      }
      elements.push(
        <ol key={key++} style={{
          margin: '8px 0',
          paddingLeft: 20,
          fontSize: '0.9rem',
          lineHeight: 1.7,
          color: '#1e293b',
        }}>
          {items.map((item) => (
            <li key={item.idx} style={{ marginBottom: 3 }}>{renderInline(item.text)}</li>
          ))}
        </ol>
      );
      continue;
    }

    // Tables
    if (line.includes('|') && line.trim().startsWith('|')) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim().startsWith('|')) {
        tableLines.push(lines[i]);
        i++;
      }
      if (tableLines.length >= 2) {
        const isSeparator = (l: string) => /^\s*\|[\s:_-|]+\|\s*$/.test(l);
        const parseCells = (l: string) => l.split('|').slice(1, -1).map(c => c.trim());
        const hasSep = tableLines.length >= 2 && isSeparator(tableLines[1]);
        const headerCells = parseCells(tableLines[0]);
        const bodyRows = tableLines.slice(hasSep ? 2 : 1).filter(l => !isSeparator(l));

        elements.push(
          <div key={key++} style={{
            overflowX: 'auto',
            margin: '12px 0',
            borderRadius: 12,
            border: '1px solid rgba(0,0,0,0.08)',
            backgroundColor: 'rgba(255,255,255,0.6)',
            boxShadow: '0 1px 3px rgba(0,0,0,0.03)',
          }}>
            <table style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: '0.85rem',
            }}>
              <thead>
                <tr>
                  {headerCells.map((cell, ci) => (
                    <th key={ci} style={{
                      textAlign: 'left',
                      paddingTop: 10,
                      paddingRight: 14,
                      paddingBottom: 10,
                      paddingLeft: 14,
                      fontWeight: 600,
                      color: '#64748b',
                      textTransform: 'uppercase',
                      letterSpacing: '0.04em',
                      fontSize: '0.75rem',
                      borderBottom: '2px solid rgba(0,0,0,0.08)',
                      whiteSpace: 'nowrap',
                    }}>
                      {renderInline(cell)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {bodyRows.map((row, ri) => {
                  const cells = parseCells(row);
                  return (
                    <tr key={ri} style={{
                      borderBottom: '1px solid rgba(0,0,0,0.04)',
                    }}>
                      {cells.map((cell, ci) => (
                        <td key={ci} style={{
                          paddingTop: 8,
                          paddingRight: 14,
                          paddingBottom: 8,
                          paddingLeft: 14,
                          color: '#1e293b',
                        }}>
                          {renderInline(cell)}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
        continue;
      }
    }

    // Checkbox items
    if (line.startsWith('- [ ] ') || line.startsWith('- [x] ') || line.startsWith('- [X] ')) {
      const items: { text: string; checked: boolean; idx: number }[] = [];
      while (i < lines.length && (lines[i].startsWith('- [ ] ') || lines[i].startsWith('- [x] ') || lines[i].startsWith('- [X] '))) {
        const checked = lines[i].startsWith('- [x] ') || lines[i].startsWith('- [X] ');
        items.push({ text: lines[i].slice(6), checked, idx: i });
        i++;
      }
      elements.push(
        <ul key={key++} style={{
          margin: '8px 0',
          paddingLeft: 4,
          listStyle: 'none',
          fontSize: '0.9rem',
          lineHeight: 1.7,
        }}>
          {items.map((item) => (
            <li key={item.idx} style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              marginBottom: 3,
              color: item.checked ? '#94a3b8' : '#1e293b',
              textDecoration: item.checked ? 'line-through' : 'none',
            }}>
              <span style={{ fontSize: 14, marginTop: 2 }}>{item.checked ? '☑' : '☐'}</span>
              {renderInline(item.text)}
            </li>
          ))}
        </ul>
      );
      continue;
    }

    // Block-level images: ![alt](url) on its own line
    const blockImgMatch = line.trim().match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (blockImgMatch) {
      elements.push(
        <InlineImage key={key++} alt={blockImgMatch[1]} src={blockImgMatch[2]} />
      );
      i++;
      continue;
    }

    // MEDIA: lines (from tool output)
    if (line.trim().startsWith('MEDIA:')) {
      const mediaPath = line.trim().slice(6).trim();
      if (mediaPath) {
        elements.push(
          <InlineImage key={key++} alt="Generated image" src={mediaPath} />
        );
      }
      i++;
      continue;
    }

    // Bare image file paths on their own line
    const bareImageMatch = line.trim().match(/^(\/[^\s]+\.(png|jpg|jpeg|gif|webp|svg))$/i);
    if (bareImageMatch) {
      elements.push(
        <InlineImage key={key++} alt={bareImageMatch[1].split('/').pop() ?? 'image'} src={bareImageMatch[1]} />
      );
      i++;
      continue;
    }

    // Empty lines
    if (!line.trim()) {
      i++;
      continue;
    }

    // Regular paragraph
    elements.push(
      <p key={key++} style={{
        margin: '6px 0',
        fontSize: '0.9rem',
        lineHeight: 1.7,
        color: '#1e293b',
      }}>
        {renderInline(line)}
      </p>
    );
    i++;
  }

  return <div>{elements}</div>;
});
