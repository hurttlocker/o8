'use client';
/* eslint-disable react-hooks/set-state-in-effect -- file fetch effect intentionally toggles loading state */

/**
 * HtmlPreview — live HTML file viewer.
 *
 * Renders `.html` / `.htm` files in a sandboxed iframe with a Preview/Source
 * segmented toggle. Sandbox is `allow-scripts` only — no allow-same-origin,
 * no allow-popups, no allow-forms.
 *
 * Source mode reuses the existing FileViewer (Monaco + diff pipeline) so we
 * don't duplicate the editor stack.
 */

import { memo, useEffect, useMemo, useState } from 'react';
import { useTheme } from '@/lib/theme/context';
import { buildPreviewSrcdoc, type HtmlStylePalette } from '@/lib/spec/html-style-presets';
import { FileViewer } from '@/components/desktop/FileViewer';

const UI_FONT = 'var(--font-sans-system)';

type View = 'preview' | 'source';

function ViewButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        border: `1px solid ${active ? 'var(--t-brand-orange)' : 'var(--t-divider-subtle)'}`,
        borderRadius: 10,
        background: active ? 'var(--t-input-bg)' : 'transparent',
        color: active ? 'var(--t-text)' : 'var(--t-text-muted)',
        cursor: 'pointer',
        fontFamily: UI_FONT,
        fontSize: 11,
        fontWeight: 600,
        minHeight: 28,
        paddingTop: 0,
        paddingRight: 10,
        paddingBottom: 0,
        paddingLeft: 10,
      }}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'var(--t-hover)'; }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
    >
      {label}
    </button>
  );
}

export const HtmlPreview = memo(function HtmlPreview({ filePath, workspace }: { filePath: string; workspace?: string }) {
  const { paletteId } = useTheme();
  const themeForIframe: HtmlStylePalette = paletteId === 'light' ? 'light' : 'midnight';
  const [view, setView] = useState<View>('preview');
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const wsParam = workspace ? `&workspace=${encodeURIComponent(workspace)}` : '';
    fetch(`/api/panel/file-content?path=${encodeURIComponent(filePath)}${wsParam}`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (typeof data?.content === 'string') setContent(data.content);
        else { setError(data?.error || 'Failed to load file.'); setContent(null); }
      })
      .catch((err) => {
        if (!cancelled) { setError(err instanceof Error ? err.message : String(err)); setContent(null); }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [filePath, workspace]);

  const breadcrumb = filePath;

  return (
    <div style={{ display: 'flex', flex: 1, flexDirection: 'column', minHeight: 0, background: 'var(--t-canvas-bg)', color: 'var(--t-text)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 42, paddingLeft: 12, paddingRight: 12, borderBottom: '1px solid var(--t-divider-subtle)', fontFamily: UI_FONT }}>
        <span
          title={breadcrumb}
          style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: error ? 'var(--t-brand-red)' : 'var(--t-text-muted)', fontSize: 11, fontWeight: 600 }}
        >
          {error ? error : breadcrumb}
        </span>
        <ViewButton active={view === 'preview'} label="Preview" onClick={() => setView('preview')} />
        <ViewButton active={view === 'source'} label="Source" onClick={() => setView('source')} />
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {view === 'preview' ? (
          <PreviewBody content={content} loading={loading} theme={themeForIframe} />
        ) : (
          // Reuse FileViewer for the source view — picks up Monaco, diff,
          // save, etc. for free. Mounted under a fresh key so switching
          // back to preview re-mounts cleanly.
          <FileViewer filePath={filePath} workspace={workspace} />
        )}
      </div>
    </div>
  );
});

function PreviewBody({ content, loading, theme }: { content: string | null; loading: boolean; theme: HtmlStylePalette }) {
  const srcdoc = useMemo(() => {
    if (content === null) return '';
    return buildPreviewSrcdoc(content, { theme });
  }, [content, theme]);

  if (loading) {
    return <div style={{ paddingTop: 16, paddingLeft: 16, color: 'var(--t-text-muted)', fontFamily: UI_FONT, fontSize: 12 }}>Loading…</div>;
  }
  if (content === null) {
    return <div style={{ paddingTop: 16, paddingLeft: 16, color: 'var(--t-text-muted)', fontFamily: UI_FONT, fontSize: 12 }}>No content.</div>;
  }
  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto', background: 'var(--t-canvas-bg)' }}>
      <iframe
        title="HTML preview"
        sandbox="allow-scripts"
        srcDoc={srcdoc}
        style={{
          display: 'block',
          width: '100%',
          minHeight: '100%',
          border: 'none',
          background: 'transparent',
        }}
      />
    </div>
  );
}
