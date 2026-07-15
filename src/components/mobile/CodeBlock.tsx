'use client';

import { useState, useEffect, createElement, memo } from 'react';
import { sanitizeAgentHtml } from '@/lib/render/sanitize-html';

interface CodeBlockProps {
  code: string;
  language?: string;
}

function formatLanguageLabel(lang?: string): string {
  if (!lang) return '';
  if (lang === 'tool-output') return 'exec output';
  const aliases: Record<string, string> = {
    ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript',
    py: 'Python', rb: 'Ruby', sh: 'Shell', bash: 'Shell', zsh: 'Shell',
    json: 'JSON', yaml: 'YAML', yml: 'YAML', css: 'CSS', html: 'HTML',
    sql: 'SQL', md: 'Markdown', diff: 'Diff', rust: 'Rust', go: 'Go',
    mermaid: 'Mermaid', toml: 'TOML', xml: 'XML', graphql: 'GraphQL',
  };
  return aliases[lang.toLowerCase()] ?? lang;
}

// Cortex brand mermaid theme — glass frost + red accent
const MERMAID_THEME = {
  theme: 'base' as const,
  themeVariables: {
    primaryColor: '#ffffff',
    primaryTextColor: '#1e293b',
    primaryBorderColor: '#e2e8f0',
    secondaryColor: '#f0f7ff',
    secondaryTextColor: '#334155',
    secondaryBorderColor: '#cbd5e1',
    tertiaryColor: '#fef2f2',
    tertiaryTextColor: '#991b1b',
    tertiaryBorderColor: '#ef4444',
    lineColor: '#94a3b8',
    textColor: '#1e293b',
    mainBkg: '#ffffff',
    nodeBorder: '#e2e8f0',
    clusterBkg: '#f8fafc',
    clusterBorder: '#e2e8f0',
    titleColor: '#0f172a',
    edgeLabelBackground: '#ffffff',
    nodeTextColor: '#1e293b',
    cScale0: '#ef4444',
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
    fontSize: '13px',
  },
};

const MermaidDiagram = memo(function MermaidDiagram({ code }: { code: string }) {
  const [svgHtml, setSvgHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function render() {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({
          startOnLoad: false,
          ...MERMAID_THEME,
          securityLevel: 'strict',
        });

        const id = `mermaid-m-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const { svg } = await mermaid.render(id, code);

        if (!cancelled) setSvgHtml(sanitizeAgentHtml(svg));
      } catch (err) {
        if (!cancelled) setError(String(err));
      }
    }

    void render();
    return () => { cancelled = true; };
  }, [code]);

  if (error) {
    return createElement('div', {
      style: {
        padding: '12px 14px',
        fontSize: '0.78rem',
        color: '#ef4444',
        fontFamily: 'ui-monospace, monospace',
      },
    }, `Diagram error: ${error}`);
  }

  return createElement('div', {
    style: {
      paddingTop: 16,
      paddingRight: 12,
      paddingBottom: 16,
      paddingLeft: 12,
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
      minHeight: svgHtml ? undefined : 50,
      backgroundColor: '#fafbfd',
      borderTop: '1px solid #e5e7eb',
      backgroundImage: 'linear-gradient(135deg, rgba(255,255,255,0.8) 0%, rgba(240,247,255,0.4) 100%)',
      overflowX: 'auto' as const,
      WebkitOverflowScrolling: 'touch' as const,
    },
  },
    svgHtml
      ? createElement('div', {
          dangerouslySetInnerHTML: { __html: svgHtml },
          style: { maxWidth: '100%', overflow: 'auto' },
        })
      : createElement('span', {
          style: { fontSize: 12, color: '#9ca3af' },
        }, 'Rendering diagram…'),
  );
});

export const CodeBlock = memo(function CodeBlock({ code, language }: CodeBlockProps) {
  const lines = code.split('\n');
  const label = formatLanguageLabel(language);
  const isMermaid = language?.toLowerCase() === 'mermaid';
  const [expanded, setExpanded] = useState(isMermaid); // Mermaid auto-expands

  return createElement('div', {
    style: {
      margin: '8px 0',
      borderRadius: '12px',
      overflow: 'hidden',
      backgroundColor: '#f8f9fa',
      border: '1px solid #e5e7eb',
    },
  },
    // Header bar
    createElement('button', {
      type: 'button',
      onClick: () => setExpanded(!expanded),
      style: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        width: '100%',
        paddingTop: 10,
        paddingRight: 14,
        paddingBottom: 10,
        paddingLeft: 14,
        border: 'none',
        backgroundColor: 'transparent',
        cursor: 'pointer',
        fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
        WebkitTapHighlightColor: 'transparent',
      },
    },
      createElement('span', {
        style: {
          fontSize: '0.75rem',
          fontWeight: 600,
          color: isMermaid ? '#ef4444' : '#6b7280',
          textTransform: 'uppercase' as const,
          letterSpacing: '0.04em',
        },
      }, isMermaid ? '◆ Mermaid' : (label || 'code')),
      createElement('span', {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          fontSize: '0.7rem',
          color: '#9ca3af',
        },
      },
        `${lines.length} lines`,
        createElement('span', {
          style: {
            fontSize: '0.6rem',
            transition: 'transform 200ms cubic-bezier(0.22, 1, 0.36, 1)',
            transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
          },
        }, '▼'),
      ),
    ),
    // Content
    expanded ? (
      isMermaid
        ? createElement(MermaidDiagram, { code })
        : createElement('pre', {
            className: 'cortex-scroll-fade-y cortex-themed-scroll',
            style: {
              margin: 0,
              paddingTop: 12,
              paddingRight: 14,
              paddingBottom: 12,
              paddingLeft: 14,
              fontSize: '0.78rem',
              lineHeight: 1.55,
              color: '#1f2937',
              fontFamily: '"SF Mono", "Menlo", "Monaco", "Cascadia Code", monospace',
              whiteSpace: 'pre-wrap' as const,
              wordBreak: 'break-word' as const,
              borderTop: '1px solid #e5e7eb',
              backgroundColor: '#ffffff',
              maxHeight: '400px',
              overflowY: 'auto' as const,
            },
          },
            createElement('code', null, code),
          )
    ) : null,
  );
});
