'use client';

import { useState, createElement } from 'react';

interface CodeBlockProps {
  code: string;
  language?: string;
}

const COLLAPSED_LINES = 4;

function formatLanguageLabel(lang?: string): string {
  if (!lang) return '';
  if (lang === 'tool-output') return 'exec output';
  const aliases: Record<string, string> = {
    ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript',
    py: 'Python', rb: 'Ruby', sh: 'Shell', bash: 'Shell', zsh: 'Shell',
    json: 'JSON', yaml: 'YAML', yml: 'YAML', css: 'CSS', html: 'HTML',
    sql: 'SQL', md: 'Markdown', diff: 'Diff', rust: 'Rust', go: 'Go',
  };
  return aliases[lang.toLowerCase()] ?? lang;
}

export function CodeBlock({ code, language }: CodeBlockProps) {
  const lines = code.split('\n');
  const isToolOutput = language === 'tool-output';
  const collapseThreshold = isToolOutput ? 3 : COLLAPSED_LINES;
  const isLong = lines.length > collapseThreshold + 2;
  const [expanded, setExpanded] = useState(false);

  const displayCode = expanded || !isLong ? code : lines.slice(0, collapseThreshold).join('\n');
  const hiddenCount = lines.length - collapseThreshold;
  const label = formatLanguageLabel(language);

  return createElement('div', {
    style: {
      margin: '10px 0',
      borderRadius: '12px',
      overflow: 'hidden',
      backgroundColor: '#1e1e1e',
      boxShadow: '0 1px 3px rgba(0,0,0,0.12)',
      border: '1px solid rgba(255,255,255,0.06)',
    },
  },
    // Header bar with language label
    label ? createElement('div', {
      style: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '6px 14px',
        backgroundColor: 'rgba(255,255,255,0.04)',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
      },
    },
      createElement('span', {
        style: {
          fontSize: '0.7rem',
          fontWeight: 600,
          color: '#8b8b8b',
          textTransform: 'uppercase' as const,
          letterSpacing: '0.06em',
        },
      }, label),
      createElement('span', {
        style: {
          fontSize: '0.65rem',
          color: '#636363',
        },
      }, `${lines.length} lines`),
    ) : null,
    // Code content
    createElement('pre', {
      style: {
        margin: 0,
        padding: '12px 14px',
        fontSize: '0.78rem',
        lineHeight: 1.55,
        color: '#d4d4d4',
        fontFamily: '"SF Mono", "Menlo", "Monaco", "Cascadia Code", monospace',
        overflowX: 'auto' as const,
        whiteSpace: 'pre' as const,
        WebkitOverflowScrolling: 'touch' as const,
      },
    },
      createElement('code', null, displayCode),
    ),
    // Expand/collapse button
    isLong ? createElement('button', {
      type: 'button',
      onClick: () => setExpanded(!expanded),
      style: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '6px',
        width: '100%',
        padding: '8px 14px',
        border: 'none',
        borderTop: '1px solid rgba(255,255,255,0.06)',
        backgroundColor: 'rgba(255,255,255,0.03)',
        color: '#8b8b8b',
        fontSize: '0.75rem',
        fontWeight: 500,
        cursor: 'pointer',
        fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
      },
    }, expanded ? '▲ Collapse' : `▼ Show ${hiddenCount} more lines`) : null,
  );
}
