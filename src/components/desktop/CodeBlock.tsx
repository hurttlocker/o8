'use client';

/**
 * CodeBlock — styled code blocks for desktop chat.
 *
 * Features:
 * - Collapsible with header bar (language label, line count, copy button)
 * - Mermaid diagrams render inline with Cortex IDE theme
 * - Syntax-highlighted text with monospace font
 * - Separate from mobile CodeBlock (per our component rule)
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Copy, Expand, Minus, Plus, X } from 'lucide-react';

interface CodeBlockProps {
  code: string;
  language?: string;
}

const LANG_ALIASES: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript',
  py: 'Python', rb: 'Ruby', sh: 'Shell', bash: 'Shell', zsh: 'Shell',
  json: 'JSON', yaml: 'YAML', yml: 'YAML', css: 'CSS', html: 'HTML',
  sql: 'SQL', md: 'Markdown', diff: 'Diff', rust: 'Rust', go: 'Go',
  mermaid: 'Mermaid', toml: 'TOML', xml: 'XML', graphql: 'GraphQL',
};

function formatLabel(lang?: string): string {
  if (!lang) return 'code';
  if (lang === 'tool-output') return 'exec output';
  return LANG_ALIASES[lang.toLowerCase()] ?? lang;
}

// Cortex IDE mermaid theme — glass white / frost with red accent
// Brand: clear glass, super light blue frost, bright red accents
const MERMAID_THEME = {
  theme: 'base' as const,
  themeVariables: {
    // Primary: frost glass white with red accent borders
    primaryColor: '#ffffff',
    primaryTextColor: '#1e293b',
    primaryBorderColor: '#e2e8f0',
    // Secondary: super light blue frost
    secondaryColor: '#f0f7ff',
    secondaryTextColor: '#334155',
    secondaryBorderColor: '#cbd5e1',
    // Tertiary: bright red (Cortex accent)
    tertiaryColor: '#fef2f2',
    tertiaryTextColor: '#991b1b',
    tertiaryBorderColor: '#ef4444',
    // Lines and text
    lineColor: '#94a3b8',
    textColor: '#1e293b',
    // Node defaults
    mainBkg: '#ffffff',
    nodeBorder: '#e2e8f0',
    clusterBkg: '#f8fafc',
    clusterBorder: '#e2e8f0',
    titleColor: '#0f172a',
    edgeLabelBackground: '#ffffff',
    nodeTextColor: '#1e293b',
    // Decision nodes (diamonds)
    cScale0: '#ef4444',
    // Typography
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
    fontSize: '14px',
  },
};

// ── Glass Modal for Mermaid Zoom ──

const DEFAULT_ZOOM = 4; // 400% — diagrams render small, this fills the viewport

function MermaidModal({ svgHtml, onClose }: { svgHtml: string; onClose: () => void }) {
  const [scale, setScale] = useState(DEFAULT_ZOOM);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const dragging = useRef(false);
  const lastPos = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === '=' || e.key === '+') setScale(s => Math.min(s + 0.25, 8));
      if (e.key === '-') setScale(s => Math.max(s - 0.25, 0.5));
      if (e.key === '0') { setScale(DEFAULT_ZOOM); setTranslate({ x: 0, y: 0 }); }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.2 : 0.2;
    setScale(s => Math.min(Math.max(s + delta, 0.5), 8));
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    dragging.current = true;
    lastPos.current = { x: e.clientX, y: e.clientY };
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging.current) return;
    const dx = e.clientX - lastPos.current.x;
    const dy = e.clientY - lastPos.current.y;
    lastPos.current = { x: e.clientX, y: e.clientY };
    setTranslate(t => ({ x: t.x + dx, y: t.y + dy }));
  }, []);

  const handleMouseUp = useCallback(() => {
    dragging.current = false;
  }, []);

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
        backdropFilter: 'blur(40px) saturate(200%) brightness(1.05)',
        WebkitBackdropFilter: 'blur(40px) saturate(200%) brightness(1.05)',
        backgroundColor: 'rgba(255, 255, 255, 0.15)',
        animation: 'fadeIn 200ms ease',
      }}
    >
      {/* Glass panel */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'relative',
          width: '90vw',
          height: '85vh',
          maxWidth: 1400,
          borderRadius: 20,
          overflow: 'hidden',
          background: 'linear-gradient(135deg, rgba(255,255,255,0.45) 0%, rgba(240,247,255,0.25) 100%)',
          border: '1px solid rgba(255,255,255,0.35)',
          boxShadow: '0 32px 80px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.03), inset 0 1px 0 rgba(255,255,255,0.6)',
          backdropFilter: 'blur(60px) saturate(180%)',
          WebkitBackdropFilter: 'blur(60px) saturate(180%)',
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingTop: 14,
          paddingRight: 16,
          paddingBottom: 14,
          paddingLeft: 20,
          borderBottom: '1px solid rgba(0,0,0,0.06)',
          background: 'rgba(255,255,255,0.2)',
        }}>
          <span style={{
            fontSize: 13,
            fontWeight: 700,
            color: '#ef4444',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            fontFamily: '-apple-system, system-ui, sans-serif',
          }}>
            ◆ Mermaid Diagram
          </span>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {/* Zoom controls */}
            <button
              type="button"
              onClick={() => setScale(s => Math.max(s - 0.5, 0.5))}
              style={modalBtnStyle}
              title="Zoom out (−)"
            >
              <Minus size={14} strokeWidth={2} />
            </button>

            <span style={{
              fontSize: 12,
              fontWeight: 600,
              color: '#64748b',
              minWidth: 40,
              textAlign: 'center',
              fontFamily: 'SF Mono, ui-monospace, monospace',
            }}>
              {Math.round(scale * 100)}%
            </span>

            <button
              type="button"
              onClick={() => setScale(s => Math.min(s + 0.5, 8))}
              style={modalBtnStyle}
              title="Zoom in (+)"
            >
              <Plus size={14} strokeWidth={2} />
            </button>

            <button
              type="button"
              onClick={() => { setScale(DEFAULT_ZOOM); setTranslate({ x: 0, y: 0 }); }}
              style={{ ...modalBtnStyle, marginLeft: 4, fontSize: 11, width: 'auto', paddingLeft: 8, paddingRight: 8 }}
              title="Reset (0)"
            >
              Fit
            </button>

            <div style={{ width: 1, height: 20, background: 'rgba(0,0,0,0.08)', marginLeft: 8, marginRight: 8 }} />

            <button
              type="button"
              onClick={onClose}
              style={{ ...modalBtnStyle, color: '#ef4444' }}
              title="Close (Esc)"
            >
              <X size={15} strokeWidth={2} />
            </button>
          </div>
        </div>

        {/* Diagram area — zoomable/pannable */}
        <div
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          style={{
            width: '100%',
            height: 'calc(100% - 52px)',
            overflow: 'hidden',
            cursor: dragging.current ? 'grabbing' : 'grab',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div
            dangerouslySetInnerHTML={{ __html: svgHtml }}
            style={{
              transform: `translate(${translate.x}px, ${translate.y}px) scale(${scale})`,
              transformOrigin: 'center center',
              transition: dragging.current ? 'none' : 'transform 100ms ease',
            }}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}

const modalBtnStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 30,
  height: 30,
  borderRadius: 8,
  border: '1px solid rgba(0,0,0,0.08)',
  background: 'rgba(255,255,255,0.7)',
  color: '#475569',
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 600,
  fontFamily: '-apple-system, system-ui, sans-serif',
  transition: 'all 150ms ease',
  paddingTop: 0,
  paddingRight: 0,
  paddingBottom: 0,
  paddingLeft: 0,
};

// ── Mermaid Diagram (inline + expand) ──

const MermaidDiagram = memo(function MermaidDiagram({ code }: { code: string }) {
  const [svgHtml, setSvgHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function render() {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({
          startOnLoad: false,
          ...MERMAID_THEME,
          securityLevel: 'loose',
        });

        const id = `mermaid-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const { svg } = await mermaid.render(id, code);

        if (!cancelled) {
          setSvgHtml(svg);
        }
      } catch (err) {
        if (!cancelled) {
          setError(String(err));
        }
      }
    }

    void render();
    return () => { cancelled = true; };
  }, [code]);

  if (error) {
    return (
      <div style={{
        paddingTop: 12,
        paddingRight: 14,
        paddingBottom: 12,
        paddingLeft: 14,
        fontSize: '0.8rem',
        color: '#ef4444',
        fontFamily: 'ui-monospace, monospace',
      }}>
        Mermaid render error: {error}
      </div>
    );
  }

  return (
    <div
      style={{
        position: 'relative',
        paddingTop: 20,
        paddingRight: 16,
        paddingBottom: 20,
        paddingLeft: 16,
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        minHeight: svgHtml ? undefined : 60,
        backgroundColor: '#fafbfd',
        borderTop: '1px solid #e5e7eb',
        backgroundImage: 'linear-gradient(135deg, rgba(255,255,255,0.8) 0%, rgba(240,247,255,0.4) 100%)',
      }}
    >
      {svgHtml ? (
        <>
          <div
            dangerouslySetInnerHTML={{ __html: svgHtml }}
            style={{ maxWidth: '100%', overflow: 'auto' }}
          />
          {/* Expand button */}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setModalOpen(true); }}
            title="Expand diagram"
            style={{
              position: 'absolute',
              top: 8,
              right: 8,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 28,
              height: 28,
              borderRadius: 8,
              border: '1px solid rgba(0,0,0,0.08)',
              background: 'rgba(255,255,255,0.85)',
              backdropFilter: 'blur(8px)',
              color: '#64748b',
              cursor: 'pointer',
              transition: 'all 150ms ease',
              boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
              paddingTop: 0,
              paddingRight: 0,
              paddingBottom: 0,
              paddingLeft: 0,
            }}
          >
            <Expand size={14} strokeWidth={2} />
          </button>
          {modalOpen ? <MermaidModal svgHtml={svgHtml} onClose={() => setModalOpen(false)} /> : null}
        </>
      ) : (
        <span style={{ fontSize: 12, color: '#9ca3af' }}>Rendering diagram…</span>
      )}
    </div>
  );
});

export const CodeBlock = memo(function CodeBlock({ code, language }: CodeBlockProps) {
  const lines = code.split('\n');
  const label = formatLabel(language);
  const isMermaid = language?.toLowerCase() === 'mermaid';
  const [expanded, setExpanded] = useState(isMermaid); // Mermaid auto-expands
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // fallback
      const ta = document.createElement('textarea');
      ta.value = code;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }, [code]);

  return (
    <div style={{
      margin: '8px 0',
      borderRadius: 12,
      overflow: 'hidden',
      backgroundColor: '#f8f9fa',
      border: '1px solid #e5e7eb',
      boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
    }}>
      {/* Header bar */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          width: '100%',
          paddingTop: 8,
          paddingRight: 12,
          paddingBottom: 8,
          paddingLeft: 14,
          border: 'none',
          backgroundColor: 'transparent',
          cursor: 'pointer',
          fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
          gap: 8,
        }}
      >
        {/* Language label */}
        <span style={{
          fontSize: '0.75rem',
          fontWeight: 600,
          color: isMermaid ? '#2563eb' : '#6b7280',
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
        }}>
          {isMermaid ? '◆ Mermaid' : label}
        </span>

        {/* Line count */}
        <span style={{
          fontSize: '0.7rem',
          color: '#9ca3af',
          marginRight: 'auto',
        }}>
          {lines.length} lines
        </span>

        {/* Copy button */}
        <span
          onClick={(e) => {
            e.stopPropagation();
            void handleCopy();
          }}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 3,
            fontSize: '0.7rem',
            color: copied ? '#22c55e' : '#9ca3af',
            cursor: 'pointer',
          }}
        >
          {copied ? <Check size={12} strokeWidth={2} /> : <Copy size={12} strokeWidth={1.8} />}
          {copied ? 'Copied' : 'Copy'}
        </span>

        {/* Chevron */}
        <ChevronDown
          size={13}
          strokeWidth={2}
          style={{
            color: '#9ca3af',
            transition: 'transform 200ms ease',
            transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
          }}
        />
      </button>

      {/* Content */}
      {expanded ? (
        isMermaid ? (
          <MermaidDiagram code={code} />
        ) : (
          <pre style={{
            margin: 0,
            paddingTop: 12,
            paddingRight: 14,
            paddingBottom: 12,
            paddingLeft: 14,
            fontSize: '0.82rem',
            lineHeight: 1.6,
            color: '#1f2937',
            fontFamily: '"SF Mono", "Menlo", "Monaco", "Cascadia Code", ui-monospace, monospace',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            borderTop: '1px solid #e5e7eb',
            backgroundColor: '#ffffff',
            maxHeight: 400,
            overflowY: 'auto',
          }}>
            <code>{code}</code>
          </pre>
        )
      ) : null}
    </div>
  );
});
