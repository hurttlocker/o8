'use client';

import { useEffect, useMemo, useState } from 'react';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { hardenPreviewDocument } from '@/lib/spec/html-style-presets';
import { FONT_FAMILY, paneLabelStyle, paneStyle } from './shared';

/**
 * #1491 — first-class explainer view. Renders the generated HTML report in a
 * sandboxed iframe (allow-scripts, no same-origin — same trust model as
 * HtmlPreview). `generating` shows a pending note; `failed`/absent renders a
 * graceful note and the parent keeps the raw diff one click away.
 */
export function PacketExplainerPane({ packet }: { packet: OrchestratorPacket }) {
  const explainer = packet.explainer ?? null;
  const artifactId = explainer?.status === 'ready' ? explainer.artifactId ?? null : null;
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sandboxedHtml = useMemo(
    () => (html ? hardenPreviewDocument(html, { allowScripts: true }) : null),
    [html],
  );

  useEffect(() => {
    if (!artifactId) {
      setHtml(null);
      return;
    }
    let cancelled = false;
    setError(null);
    (async () => {
      try {
        const response = await fetch(`/api/panel/report-artifact?id=${encodeURIComponent(artifactId)}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json() as { html?: string; error?: string };
        if (cancelled) return;
        if (typeof payload.html !== 'string') throw new Error(payload.error ?? 'No explainer content.');
        setHtml(payload.html);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Unable to load explainer.');
      }
    })();
    return () => { cancelled = true; };
  }, [artifactId]);

  return (
    <div style={paneStyle()}>
      <div style={paneLabelStyle()}>EXPLAINER</div>
      {explainer?.status === 'generating' ? (
        <div style={{ fontSize: 10.5, color: 'var(--t-text-muted)', fontFamily: FONT_FAMILY }}>
          Explainer generating…
        </div>
      ) : null}
      {(!explainer || explainer.status === 'failed') ? (
        <div style={{ fontSize: 10.5, color: 'var(--t-text-muted)', fontFamily: FONT_FAMILY }}>
          No explainer available — review the diff.
        </div>
      ) : null}
      {error ? (
        <div style={{ fontSize: 10.5, color: '#b91c1c', fontFamily: FONT_FAMILY }}>{error}</div>
      ) : null}
      {sandboxedHtml !== null && !error ? (
        <div style={{ flex: 1, minHeight: 320, overflow: 'hidden', borderRadius: 8, borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--t-divider)' }}>
          <iframe
            title="Packet explainer"
            sandbox="allow-scripts"
            srcDoc={sandboxedHtml}
            style={{ display: 'block', width: '100%', height: '100%', minHeight: 320, border: 'none', background: '#fff' }}
          />
        </div>
      ) : null}
    </div>
  );
}
