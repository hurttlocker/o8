'use client';

import { useEffect, useMemo, useState } from 'react';
import './pr-code-theme';
import { getFiletypeFromFileName, preloadHighlighter } from '@pierre/diffs';
import { FileDiff, type FileDiffOptions } from '@pierre/diffs/react';
import { useTheme } from '@/lib/theme/context';
import { getPalette } from '@/lib/theme/registry';
import { parsePrFilePatch } from './pr-patch';
import type { PrFile } from './types';



// Static, trusted overrides also reach the library's isolated shadow tree.
const css = `:host {
  --diffs-font-family: var(--font-ui, system-ui);
  --diffs-header-font-family: var(--font-ui);
  --diffs-font-size: 12px;
  --diffs-line-height: 20px;
  --diffs-bg: var(--t-canvas-bg);
  --diffs-fg: var(--t-text);
  --diffs-fg-number: var(--t-text-muted);
  --diffs-addition-base: var(--t-success);
  --diffs-deletion-base: var(--t-danger);
  --diffs-modified-base: var(--t-accent);
  --diffs-bg-separator: transparent;
  --diffs-bg-context: transparent;
}
* { scrollbar-width: none; }
*::-webkit-scrollbar { display: none; width: 0; height: 0; }
[data-separator-content] { font-family: var(--font-ui, system-ui); font-size: 10px; gap: 10px; }
[data-separator-content]::before, [data-separator-content]::after { content: ''; flex: 1; height: 1px; background: var(--t-divider-subtle); }
[data-line] { overflow-wrap: anywhere; }
[data-line-type=change-addition] { --diffs-computed-diff-line-bg: color-mix(in srgb, var(--t-success) 10%, transparent); }
[data-line-type=change-deletion] { --diffs-computed-diff-line-bg: color-mix(in srgb, var(--t-danger) 10%, transparent); }
`;

export default function PierrePrDiff({ file, diffStyle }: { file: PrFile; diffStyle: 'unified' | 'split' }) {
  const { workspaceGlass, paletteId } = useTheme();
  const themeType = workspaceGlass ? 'dark' : getPalette(paletteId).colorScheme;
  const { path, previousPath, status, patch } = file;
  const fileDiff = useMemo(() => parsePrFilePatch({ path, previousPath, status, patch }), [path, previousPath, status, patch]);
  const [prepared, setPrepared] = useState<{ diff: typeof fileDiff; error?: Error } | null>(null);
  useEffect(() => {
    let current = true;
    const timeout = window.setTimeout(() => { if (current) setPrepared({ diff: fileDiff, error: new Error('Code view preparation timed out.') }); }, 15_000);
    // The renderer's internal asynchronous highlighter has no error callback.
    // Prepare it explicitly so a failed language chunk cannot leave an empty view.
    preloadHighlighter({ themes: ['o8-pr-code'], langs: [getFiletypeFromFileName(fileDiff.name), ...(fileDiff.prevName ? [getFiletypeFromFileName(fileDiff.prevName)] : [])], preferredHighlighter: 'shiki-js' }).then(() => {
      if (current) { window.clearTimeout(timeout); setPrepared({ diff: fileDiff }); }
    }).catch(() => {
      if (current) { window.clearTimeout(timeout); setPrepared({ diff: fileDiff, error: new Error('Code view preparation failed.') }); }
    });
    return () => { current = false; window.clearTimeout(timeout); };
  }, [fileDiff]);
  const options = useMemo<FileDiffOptions<undefined, undefined>>(() => ({
    theme: 'o8-pr-code', themeType, diffStyle, overflow: 'wrap',
    disableFileHeader: true, diffIndicators: 'bars', hunkSeparators: 'line-info',
    lineDiffType: 'word-alt', unsafeCSS: css,
  }), [themeType, diffStyle]);
  if (prepared?.diff === fileDiff && prepared.error) throw prepared.error;
  if (prepared?.diff !== fileDiff) return <div role="status" style={{ padding: 14, fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--t-text-muted)' }}>Preparing code view…</div>;
  return <FileDiff fileDiff={fileDiff} options={options} />;
}
