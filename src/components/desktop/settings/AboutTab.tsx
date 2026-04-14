'use client';

import packageJson from '../../../../package.json';
import {
  THEME_ACCENT,
  THEME_ACCENT_BORDER,
  THEME_ACCENT_SOFT,
  normalizeVersion,
} from './shared';

export function AboutTab() {
  const isProduction = process.env.NODE_ENV === 'production';
  const platform = (() => {
    if (typeof navigator !== 'undefined' && navigator.platform) return navigator.platform;
    return '—';
  })();

  const systemInfo = [
    { label: 'Platform', value: platform },
    { label: 'Version', value: normalizeVersion(packageJson.version) },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 760 }}>
      <div style={{
        background: 'var(--t-panel)',
        borderRadius: 14,
        border: '1px solid var(--t-panel-border)',
        boxShadow: 'var(--t-panel-shadow)',
        padding: 24,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
          <h3 style={{ fontSize: 22, fontWeight: 700, color: 'var(--t-text)', margin: 0 }}>o8</h3>
          <span style={{
            fontSize: 11,
            fontWeight: 700,
            padding: '4px 9px',
            borderRadius: 999,
            background: THEME_ACCENT_SOFT,
            color: THEME_ACCENT,
          }}>
            {normalizeVersion(packageJson.version)}
          </span>
        </div>
        <p style={{ fontSize: 13, color: 'var(--t-text-secondary)', margin: '0 0 18px', lineHeight: 1.5 }}>
          Built with Next.js + Tauri
        </p>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          gap: 12,
        }}>
          {systemInfo.map((item) => (
            <div key={item.label} style={{
              padding: 14,
              borderRadius: 12,
              background: 'var(--t-bg-card, rgba(148, 163, 184, 0.08))',
              border: '1px solid var(--t-panel-border)',
            }}>
              <div style={{ fontSize: 11, color: 'var(--t-text-muted)', marginBottom: 6 }}>{item.label}</div>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--t-text)' }}>{item.value}</div>
            </div>
          ))}
        </div>
      </div>

      <div style={{
        background: 'var(--t-panel)',
        borderRadius: 14,
        border: '1px solid var(--t-panel-border)',
        boxShadow: 'var(--t-panel-shadow)',
        padding: 24,
      }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--t-text)', marginBottom: 6 }}>Links</div>
        <p style={{ fontSize: 12, color: 'var(--t-text-muted)', margin: '0 0 14px', lineHeight: 1.5 }}>
          Project resources and release surfaces.
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          {[
            { label: 'GitHub', href: 'https://github.com/hurttlocker/cortex-ide' },
            { label: 'Docs', href: 'https://github.com/hurttlocker/cortex-ide/tree/main/docs' },
            { label: 'Releases', href: 'https://github.com/hurttlocker/cortex-ide/releases/latest' },
          ].map((link) => (
            <a
              key={link.label}
              href={link.href}
              target="_blank"
              rel="noreferrer"
              style={{
                padding: '8px 12px',
                borderRadius: 10,
                border: '1px solid var(--t-panel-border)',
                background: 'var(--t-bg-card, rgba(148, 163, 184, 0.08))',
                color: 'var(--t-text-secondary)',
                fontSize: 12,
                fontWeight: 600,
                textDecoration: 'none',
              }}
            >
              {link.label}
            </a>
          ))}
        </div>
      </div>

      {!isProduction && (
        <div style={{
          background: 'var(--t-panel)',
          borderRadius: 14,
          border: '1px dashed rgba(239, 68, 68, 0.3)',
          padding: 24,
        }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--t-text)', marginBottom: 4 }}>Developer Tools</div>
          <p style={{ fontSize: 11, color: 'var(--t-text-muted)', margin: '0 0 14px' }}>Visible only in non-production builds.</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <button
              type="button"
              onClick={async () => {
                await fetch('/api/setup/config', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ setupComplete: false, completedAt: null }),
                });
                window.location.href = '/dashboard';
              }}
              style={{
                padding: '8px 14px', borderRadius: 10,
                border: `1px solid ${THEME_ACCENT_BORDER}`,
                background: THEME_ACCENT_SOFT,
                color: THEME_ACCENT, fontSize: 12, fontWeight: 600, cursor: 'pointer',
              }}
            >
              ▸ Reset + Run Onboarding
            </button>
            <button
              type="button"
              onClick={() => {
                window.dispatchEvent(new CustomEvent('o8-trigger-onboarding'));
              }}
              style={{
                padding: '8px 14px', borderRadius: 10,
                border: `1px solid ${THEME_ACCENT_BORDER}`,
                background: THEME_ACCENT_SOFT,
                color: THEME_ACCENT, fontSize: 12, fontWeight: 600, cursor: 'pointer',
              }}
            >
              ▸ Preview Onboarding
            </button>
            <button
              type="button"
              onClick={async () => {
                const res = await fetch('/api/setup/detect');
                const data = await res.json();
                alert(JSON.stringify(data, null, 2));
              }}
              style={{
                padding: '8px 14px', borderRadius: 10,
                border: '1px solid var(--t-panel-border)',
                background: 'var(--t-bg-card, rgba(148, 163, 184, 0.08))',
                color: 'var(--t-text)', fontSize: 12, fontWeight: 500, cursor: 'pointer',
              }}
            >
              ▸ View Detection
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
