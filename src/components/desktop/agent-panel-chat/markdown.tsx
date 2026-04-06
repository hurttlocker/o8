'use client';

import React, { useState } from 'react';
import ReactDOM from 'react-dom';
import { CodeBlock } from '../CodeBlock';
import { TABLE_HEADER_CELL_STYLE, TABLE_BODY_CELL_STYLE } from './constants';
import { sanitizeTranscriptText, resolveImageSrc } from './shared';
import type { RenderedBlock } from './types';

export function ChatImage({ src, alt }: { src: string; alt: string }) {
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
          maxHeight: 360,
          borderRadius: 10,
          marginTop: 8,
          marginBottom: 8,
          cursor: 'zoom-in',
          boxShadow: '0 2px 12px var(--t-divider)',
          border: '1px solid var(--t-divider)',
          display: 'block',
        }}
      />
      {lightbox && ReactDOM.createPortal(
        <div
          onClick={() => setLightbox(false)}
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
            onClick={() => setLightbox(false)}
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
            ✕
          </button>
          <img
            src={resolved}
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
      )}
    </>
  );
}

export function renderInline(text: string): React.ReactNode {
  const parts = sanitizeTranscriptText(text).split(/(!\[[^\]]*\]\([^)]+\)|`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g);
  return parts.map((part, i) => {
    const imgMatch = part.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (imgMatch) {
      return <ChatImage key={i} alt={imgMatch[1]} src={imgMatch[2]} />;
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={i} className="remodex-rich-inline-code">{part.slice(1, -1)}</code>;
    }
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    const linkMatch = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (linkMatch) {
      return (
        <a key={i} href={linkMatch[2]} target="_blank" rel="noopener noreferrer"
          style={{ color: '#2563eb', textDecoration: 'none', borderBottom: '1px solid rgba(37,99,235,0.3)' }}>
          {linkMatch[1]}
        </a>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

export function renderMarkdownBlocks(text: string, onOpenMermaid?: (code: string) => void, onRunInTerminal?: (command: string) => void): RenderedBlock[] {
  const lines = sanitizeTranscriptText(text).split('\n');
  const blocks: RenderedBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++;
      const raw = codeLines.join('\n');
      blocks.push({
        rawText: lang?.toLowerCase() === 'mermaid' ? 'diagram' : raw,
        element: <CodeBlock key={`code-${i}`} code={raw} language={lang || undefined} onOpenMermaid={onOpenMermaid} onRunInTerminal={onRunInTerminal} />,
      });
      continue;
    }

    if (line.startsWith('## ')) {
      const raw = line.slice(3);
      blocks.push({
        rawText: raw,
        element: <h3 key={`h-${i}`} className="remodex-rich-heading">{raw}</h3>,
      });
      i++;
      continue;
    }
    if (line.startsWith('# ')) {
      const raw = line.slice(2);
      blocks.push({
        rawText: raw,
        element: <h2 key={`h-${i}`} className="remodex-rich-heading">{raw}</h2>,
      });
      i++;
      continue;
    }

    if (line.startsWith('- ') || line.startsWith('* ')) {
      const listItems: { text: string; key: number }[] = [];
      while (i < lines.length && (lines[i].startsWith('- ') || lines[i].startsWith('* '))) {
        listItems.push({ text: lines[i].slice(2), key: i });
        i++;
      }
      const raw = listItems.map(item => item.text).join('. ');
      blocks.push({
        rawText: raw,
        element: (
          <ul key={`ul-${listItems[0].key}`} className="remodex-rich-list">
            {listItems.map(item => (
              <li key={item.key}>{renderInline(item.text)}</li>
            ))}
          </ul>
        ),
      });
      continue;
    }

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
        const raw = [headerCells.join(', '), ...bodyRows.map(r => parseCells(r).join(', '))].join('. ');

        blocks.push({
          rawText: raw,
          element: (
            <div key={`table-${i}`} style={{
              overflowX: 'auto',
              margin: '12px 0',
              borderRadius: 12,
              border: '1px solid var(--t-divider)',
              backgroundColor: 'var(--t-panel)',
              boxShadow: '0 1px 3px var(--t-divider-subtle)',
            }}>
              <table style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
              }}>
                <thead>
                  <tr>
                    {headerCells.map((cell, ci) => (
                      <th key={ci} style={TABLE_HEADER_CELL_STYLE}>
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
                        backgroundColor: ri % 2 === 0 ? 'var(--t-panel)' : 'var(--t-bg)',
                      }}>
                        {cells.map((cell, ci) => (
                          <td key={ci} style={TABLE_BODY_CELL_STYLE}>
                            {renderInline(cell)}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ),
        });
      }
      continue;
    }

    const blockImgMatch = line.trim().match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (blockImgMatch) {
      blocks.push({
        rawText: blockImgMatch[1] || 'image',
        element: <ChatImage key={`img-${i}`} alt={blockImgMatch[1]} src={blockImgMatch[2]} />,
      });
      i++;
      continue;
    }

    const bareImgMatch = line.trim().match(/^(\/[^\s]+\.(png|jpg|jpeg|gif|webp|svg))$/i);
    if (bareImgMatch) {
      blocks.push({
        rawText: bareImgMatch[1].split('/').pop() ?? 'image',
        element: <ChatImage key={`img-${i}`} alt={bareImgMatch[1].split('/').pop() ?? 'image'} src={bareImgMatch[1]} />,
      });
      i++;
      continue;
    }

    if (line.trim().startsWith('MEDIA:')) {
      const mediaPath = line.trim().slice(6).trim();
      if (mediaPath) {
        blocks.push({
          rawText: 'image',
          element: <ChatImage key={`media-${i}`} alt="Generated image" src={mediaPath} />,
        });
      }
      i++;
      continue;
    }

    if (!line.trim()) { i++; continue; }

    blocks.push({
      rawText: line.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1'),
      element: <p key={`p-${i}`} className="remodex-rich-paragraph">{renderInline(line)}</p>,
    });
    i++;
  }

  return blocks;
}
