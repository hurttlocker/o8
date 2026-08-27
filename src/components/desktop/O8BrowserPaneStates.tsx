'use client';

import { useState } from 'react';
import type { DetectedLocalhostPreview } from '@/lib/panel/preview';
import { isLoopbackBrowserUrl } from '@/lib/browser/url';

export function BrowserTabFavicon({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  const host = (() => {
    try {
      const parsed = new URL(url);
      if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && !isLoopbackBrowserUrl(url)) {
        return parsed.hostname;
      }
    } catch {
      return null;
    }
    return null;
  })();
  if (!host || failed) return <BrowserGlobeIcon />;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- remote favicons are tiny fallbacks, not page content.
    <img
      src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`}
      width={12}
      height={12}
      alt=""
      onError={() => setFailed(true)}
      style={{ flexShrink: 0, display: 'block', width: 12, height: 12, minWidth: 12, borderRadius: 3 }}
    />
  );
}

function BrowserGlobeIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--t-text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, display: 'block', width: 12, height: 12, minWidth: 12 }}>
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}

export function BrowserRedactedState() {
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 32, textAlign: 'center' }}>
      <BrowserGlobeIcon />
      <span style={{ color: 'var(--t-text)', fontSize: 13.5, fontWeight: 400 }}>Navigate again to reopen this page</span>
      <span style={{ maxWidth: 360, color: 'var(--t-text-faint)', fontSize: 12, fontWeight: 300, lineHeight: 1.45 }}>
        Its address contained credentials or a signed value, so o8 did not save it across the restart.
      </span>
    </div>
  );
}

export function BrowserNewTabState({
  previews,
  onNavigate,
}: {
  previews: DetectedLocalhostPreview[];
  onNavigate: (url: string) => void;
}) {
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 18, padding: 32 }}>
      <span style={{ color: 'var(--t-text-muted)', fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px' }}>
        Open a running dev server
      </span>
      {previews.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%', maxWidth: 320 }}>
          {previews.map((preview) => (
            <button
              key={preview.id}
              type="button"
              onClick={() => onNavigate(preview.url || `http://localhost:${preview.port}`)}
              style={{
                display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left',
                paddingTop: 12, paddingRight: 16, paddingBottom: 12, paddingLeft: 14,
                borderRadius: 12, border: '1px solid var(--t-divider)',
                background: 'var(--t-input-bg)', cursor: 'pointer',
                boxShadow: '0 1px 2px rgba(40,30,20,0.04), 0 4px 14px rgba(40,30,20,0.05)',
                transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1), border-color 120ms cubic-bezier(0.22, 1, 0.36, 1)',
              }}
              onMouseEnter={(event) => {
                event.currentTarget.style.background = 'var(--t-panel-hover)';
                event.currentTarget.style.borderColor = 'var(--t-divider-strong)';
              }}
              onMouseLeave={(event) => {
                event.currentTarget.style.background = 'var(--t-input-bg)';
                event.currentTarget.style.borderColor = 'var(--t-divider)';
              }}
            >
              <div style={{ width: 34, height: 34, borderRadius: 9, flexShrink: 0, background: 'var(--t-panel-active)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
                  <circle cx="12" cy="12" r="10" />
                  <line x1="2" y1="12" x2="22" y2="12" />
                  <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                </svg>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 1, minWidth: 0 }}>
                <span style={{ color: 'var(--t-text)', fontSize: 14, fontWeight: 500, letterSpacing: '-0.2px' }}>
                  :{preview.port}
                </span>
                <span style={{ color: 'var(--t-text-faint)', fontSize: 11, fontWeight: 300, letterSpacing: '-0.05px' }}>
                  localhost
                </span>
              </div>
            </button>
          ))}
        </div>
      ) : (
        <span style={{ color: 'var(--t-text-faint)', fontSize: 12, fontWeight: 300 }}>
          No dev servers detected
        </span>
      )}
    </div>
  );
}
