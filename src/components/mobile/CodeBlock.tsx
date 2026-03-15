'use client';

import { useState, createElement } from 'react';

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
  };
  return aliases[lang.toLowerCase()] ?? lang;
}

export function CodeBlock({ code, language }: CodeBlockProps) {
  const lines = code.split('\n');
  const label = formatLanguageLabel(language);
  const [expanded, setExpanded] = useState(false);

  return createElement('div', {
    style: {
      margin: '8px 0',
      borderRadius: '12px',
      overflow: 'hidden',
      backgroundColor: '#f8f9fa',
      border: '1px solid #e5e7eb',
    },
  },
    // Header bar — always visible, acts as the toggle
    createElement('button', {
      type: 'button',
      onClick: () => setExpanded(!expanded),
      style: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        width: '100%',
        padding: '10px 14px',
        border: 'none',
        backgroundColor: 'transparent',
        cursor: 'pointer',
        fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
      },
    },
      createElement('span', {
        style: {
          fontSize: '0.75rem',
          fontWeight: 600,
          color: '#6b7280',
          textTransform: 'uppercase' as const,
          letterSpacing: '0.04em',
        },
      }, label || 'code'),
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
            transition: 'transform 200ms ease',
            transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
          },
        }, '▼'),
      ),
    ),
    // Code content — collapsed by default
    expanded ? createElement('pre', {
      style: {
        margin: 0,
        padding: '12px 14px',
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
    ) : null,
  );
}
