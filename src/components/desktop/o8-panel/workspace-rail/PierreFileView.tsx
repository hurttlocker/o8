'use client';

import '../../pr-panel/pr-code-theme';
import { useEffect, useMemo, useState } from 'react';
import { getFiletypeFromFileName, preloadHighlighter } from '@pierre/diffs';
import { File, type FileOptions } from '@pierre/diffs/react';
import { useTheme } from '@/lib/theme/context';
import { getPalette } from '@/lib/theme/registry';

const css = `
:host { --diffs-font-family: "SF Mono", ui-monospace, "Cascadia Code", Menlo, monospace; --diffs-font-size: 12px; --diffs-line-height: 19px; --diffs-gap-block: 8px; --diffs-min-number-column-width: 36px; --diffs-padding-inline: 12px; --diffs-bg: transparent; --diffs-fg: var(--t-text); --diffs-fg-number: var(--t-text-muted); --diffs-bg-context: transparent; }
* { scrollbar-width: none; }
*::-webkit-scrollbar { display: none; width: 0; height: 0; }
[data-line] { overflow-wrap: anywhere; }
`;

export default function PierreFileView({ path, content, fallback, wrap = true }: { path: string; content: string; fallback: React.ReactNode; wrap?: boolean }) {
  const { workspaceGlass, paletteId } = useTheme();
  const themeType = workspaceGlass ? 'dark' : getPalette(paletteId).colorScheme;
  const file = useMemo(() => ({ name: path, contents: content }), [path, content]);
  const [prepared, setPrepared] = useState<{ file: typeof file; failed?: boolean } | null>(null);
  useEffect(() => {
    let current = true;
    const timeout = window.setTimeout(() => { if (current) setPrepared({ file, failed: true }); }, 15_000);
    preloadHighlighter({ themes: ['o8-pr-code'], langs: [getFiletypeFromFileName(path)], preferredHighlighter: 'shiki-js' }).then(() => {
      if (current) { window.clearTimeout(timeout); setPrepared({ file }); }
    }).catch(() => {
      if (current) { window.clearTimeout(timeout); setPrepared({ file, failed: true }); }
    });
    return () => { current = false; window.clearTimeout(timeout); };
  }, [file, path]);
  const options = useMemo<FileOptions<undefined, undefined>>(() => ({ theme: 'o8-pr-code', themeType, overflow: wrap ? 'wrap' : 'scroll', disableFileHeader: true, disableErrorHandling: true, unsafeCSS: `${css}\n[data-line] { overflow-wrap: ${wrap ? 'anywhere' : 'normal'}; }` }), [themeType, wrap]);
  if (prepared?.file === file && prepared.failed) throw new Error('Syntax colors could not load.');
  if (prepared?.file !== file) return fallback;
  return <File file={file} options={options} />;
}
