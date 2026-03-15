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
import { Check, ChevronDown, Copy } from 'lucide-react';

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

const MermaidDiagram = memo(function MermaidDiagram({ code }: { code: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [rendered, setRendered] = useState(false);

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

        if (!cancelled && containerRef.current) {
          containerRef.current.innerHTML = svg;
          // Style the SVG
          const svgEl = containerRef.current.querySelector('svg');
          if (svgEl) {
            svgEl.style.maxWidth = '100%';
            svgEl.style.height = 'auto';
          }
          setRendered(true);
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
        padding: '12px 14px',
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
      ref={containerRef}
      style={{
        padding: '20px 16px',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        minHeight: rendered ? undefined : 60,
        backgroundColor: '#fafbfd',
        borderTop: '1px solid #e5e7eb',
        backgroundImage: 'linear-gradient(135deg, rgba(255,255,255,0.8) 0%, rgba(240,247,255,0.4) 100%)',
      }}
    >
      {!rendered ? (
        <span style={{ fontSize: 12, color: '#9ca3af' }}>Rendering diagram…</span>
      ) : null}
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
