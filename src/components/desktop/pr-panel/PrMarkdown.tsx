'use client';

import { memo, useMemo } from 'react';
import { MarkdownBody } from '../MarkdownBody';
import type { PrDetail } from './types';

function descriptionLink(href: string, detail: PrDetail): string | null {
  try {
    const source = new URL(detail.url);
    const [owner, repo] = source.pathname.split('/').filter(Boolean);
    const base = `${source.origin}/${owner}/${repo}/blob/${encodeURIComponent(detail.headRefName)}/`;
    const resolved = new URL(href, base);
    return ['https:', 'http:'].includes(resolved.protocol) ? resolved.href : null;
  } catch { return null; }
}

export const PrMarkdown = memo(function PrMarkdown({ text, detail, onOpenFile }: { text: string; detail: PrDetail; onOpenFile: (path: string) => void }) {
  const knownFiles = useMemo(() => {
    const names = new Map<string, string | null>();
    for (const file of detail.files) {
      const basename = file.path.split('/').at(-1)!;
      names.set(basename, names.has(basename) ? null : file.path);
    }
    for (const file of detail.files) names.set(file.path, file.path);
    return names;
  }, [detail.files]);
  return <MarkdownBody text={text} compact resolveLink={(href) => descriptionLink(href, detail)} renderInlineCode={(code) => {
        const path = knownFiles.get(code.replace(/^\.\//, ''));
        return path ? <button type="button" onClick={() => onOpenFile(path)} aria-label={`View changes in ${path}`} style={{ display: 'inline', border: '1px solid var(--t-divider-subtle)', borderRadius: 5, paddingTop: 1, paddingRight: 5, paddingBottom: 1, paddingLeft: 5, background: 'var(--t-code-bg)', color: 'var(--t-accent)', fontFamily: 'var(--font-mono)', fontSize: '0.85em', cursor: 'pointer', textAlign: 'left', overflowWrap: 'anywhere' }}>{code}</button> : undefined;
      }} />;
});
