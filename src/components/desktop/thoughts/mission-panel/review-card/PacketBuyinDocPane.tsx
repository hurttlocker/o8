'use client';

import { useEffect, useMemo, useState } from 'react';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { hardenPreviewDocument } from '@/lib/spec/html-style-presets';
import { FONT_FAMILY } from './shared';

/**
 * #1492 — released-card affordance for the buy-in doc. Renders NOTHING unless a
 * doc is ready (no placeholder when absent). When ready it shows a small
 * "Buy-in doc" button that expands the generated HTML in a sandboxed iframe
 * (allow-scripts, no same-origin — same trust boundary as the #1491 explainer),
 * plus an "Open in new tab" that hands the operator a self-contained copy to
 * share externally.
 */
export function PacketBuyinDocPane({ packet }: { packet: OrchestratorPacket }) {
  const buyinDoc = packet.buyinDoc ?? null;
  const artifactId = buyinDoc?.status === 'ready' ? buyinDoc.artifactId ?? null : null;
  const [open, setOpen] = useState(false);
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sandboxedHtml = useMemo(
    () => (html ? hardenPreviewDocument(html, { allowScripts: true }) : null),
    [html],
  );

  useEffect(() => {
    if (!open || !artifactId) return;
    let cancelled = false;
    setError(null);
    (async () => {
      try {
        const response = await fetch(`/api/panel/report-artifact?id=${encodeURIComponent(artifactId)}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json() as { html?: string; error?: string };
        if (cancelled) return;
        if (typeof payload.html !== 'string') throw new Error(payload.error ?? 'No buy-in doc content.');
        setHtml(payload.html);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Unable to load buy-in doc.');
      }
    })();
    return () => { cancelled = true; };
  }, [open, artifactId]);

  if (!artifactId) return null;

  const openInNewTab = () => {
    if (!html) return;
    const blob = new Blob([hardenPreviewDocument(html)], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener,noreferrer');
    // Revoke after the tab has had a chance to load the document.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  return (
    <div
      data-packet-row
      style={{
        borderTopWidth: 1,
        borderTopStyle: 'solid',
        borderTopColor: 'var(--t-divider-subtle)',
        paddingTop: 8,
        paddingRight: 10,
        paddingBottom: 8,
        paddingLeft: 10,
        fontFamily: FONT_FAMILY,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            paddingTop: 4,
            paddingRight: 9,
            paddingBottom: 4,
            paddingLeft: 8,
            borderRadius: 7,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--t-accent-border)',
            background: 'var(--t-accent-soft)',
            color: 'var(--t-accent)',
            cursor: 'pointer',
            fontSize: 11,
          }}
        >
          <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
            <path d="M3 11l18-5v12L3 14v-3z" />
            <path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" />
          </svg>
          Buy-in doc
        </button>
        {open && sandboxedHtml ? (
          <button
            type="button"
            onClick={openInNewTab}
            style={{
              borderWidth: 0,
              background: 'transparent',
              color: 'var(--t-text-muted)',
              cursor: 'pointer',
              fontSize: 10.5,
              textDecoration: 'underline',
            }}
          >
            Open in new tab
          </button>
        ) : null}
      </div>

      {open && error ? (
        <div style={{ marginTop: 8, fontSize: 10.5, color: '#b91c1c' }}>{error}</div>
      ) : null}
      {open && sandboxedHtml && !error ? (
        <div style={{ marginTop: 8, height: 360, overflow: 'hidden', borderRadius: 8, borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--t-divider)' }}>
          <iframe
            title="Buy-in doc"
            sandbox="allow-scripts"
            srcDoc={sandboxedHtml}
            style={{ display: 'block', width: '100%', height: '100%', border: 'none', background: '#fff' }}
          />
        </div>
      ) : null}
    </div>
  );
}
