'use client';

import type { DetectedLocalhostPreview } from '@/lib/panel/preview';

/** Compatibility for saved layouts; local pages now belong to the Browser. */
export function LegacyPreviewRecovery({
  previews,
  selectedPreviewId,
  onOpenBrowser,
  onClose,
}: {
  previews: DetectedLocalhostPreview[];
  selectedPreviewId?: string | null;
  onOpenBrowser: (url?: string) => void;
  onClose: () => void;
}) {
  const selected = previews.find(preview => preview.id === selectedPreviewId) ?? previews[0];
  const buttonStyle = {
    minHeight: 32, paddingTop: 6, paddingRight: 12, paddingBottom: 6, paddingLeft: 12,
    border: '1px solid var(--t-border)', borderRadius: 8, background: 'var(--t-panel-hover)',
    color: 'var(--t-text)', fontSize: 12, cursor: 'pointer',
  };
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24, boxSizing: 'border-box', textAlign: 'center', color: 'var(--t-text)' }}>
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z" />
      </svg>
      <span style={{ fontSize: 14, fontWeight: 500 }}>Local apps open in Browser</span>
      <span style={{ maxWidth: 280, fontSize: 12, lineHeight: 1.5, color: 'var(--t-text-muted)' }}>Close this old Preview pane to get your workspace space back.</span>
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 8 }}>
        <button type="button" style={buttonStyle} onClick={() => { onOpenBrowser(selected?.url); onClose(); }}>Open in Browser</button>
        <button type="button" style={buttonStyle} onClick={onClose}>Close preview</button>
      </div>
    </div>
  );
}
