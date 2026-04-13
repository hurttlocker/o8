'use client';

import { useEffect, useState, useCallback } from 'react';
import { Download, RefreshCw } from './lucide-shims';

interface UpdateInfo {
  version: string;
  notes?: string;
  date?: string;
}

const UPDATE_CHECK_INTERVAL = 30 * 60 * 1000; // 30 minutes
/**
 * UpdateBanner — shows a slim banner at the top of the dashboard when
 * a new version is available. On Tauri desktop, uses the native updater.
 * We intentionally skip browser-only update fetches in local/web mode to
 * avoid noisy CORS console failures against GitHub release assets.
 */
export function UpdateBanner() {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [installing, setInstalling] = useState(false);

  const checkForUpdate = useCallback(async () => {
    try {
      // Try Tauri native updater first
      if (typeof window !== 'undefined' && '__TAURI__' in window) {
        const { check } = await import('@tauri-apps/plugin-updater');
        const result = await check();
        if (result?.available) {
          setUpdate({
            version: result.version,
            notes: result.body ?? undefined,
            date: result.date ?? undefined,
          });
        }
        return;
      }

      // Browser/dev mode: skip remote release polling.
      // The desktop product path should use the Tauri updater instead.
      return;
    } catch {
      // Silently fail — update checks are non-critical
    }
  }, []);

  useEffect(() => {
    // Check on mount after a short delay (don't block initial render)
    const initial = window.setTimeout(() => void checkForUpdate(), 5000);
    const interval = window.setInterval(() => void checkForUpdate(), UPDATE_CHECK_INTERVAL);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [checkForUpdate]);

  const handleInstall = useCallback(async () => {
    if (typeof window !== 'undefined' && '__TAURI__' in window) {
      try {
        setInstalling(true);
        const { check } = await import('@tauri-apps/plugin-updater');
        const result = await check();
        if (result?.available) {
          await result.downloadAndInstall();
          // Relaunch after install
          const { relaunch } = await import('@tauri-apps/plugin-process');
          await relaunch();
        }
      } catch (err) {
        console.error('Update install failed:', err);
        setInstalling(false);
      }
    } else {
      // Web fallback — open releases page
      window.open('https://github.com/hurttlocker/cortex-ide/releases/latest', '_blank');
    }
  }, []);

  if (!update || dismissed) return null;

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      padding: '8px 16px',
      background: 'linear-gradient(135deg, rgba(37, 99, 235, 0.08), rgba(124, 58, 237, 0.08))',
      borderBottom: '1px solid rgba(37, 99, 235, 0.15)',
      fontSize: 13,
      color: 'var(--t-text)',
      zIndex: 9100,
    }}>
      <Download size={14} style={{ color: '#2563eb', flexShrink: 0 }} />
      <span style={{ flex: 1 }}>
        <strong>o8 {update.version}</strong> is available
        {update.notes ? ` — ${update.notes.slice(0, 80)}${update.notes.length > 80 ? '…' : ''}` : ''}
      </span>
      <button
        type="button"
        onClick={handleInstall}
        disabled={installing}
        style={{
          padding: '4px 12px',
          borderRadius: 8,
          border: '1px solid rgba(37, 99, 235, 0.3)',
          background: installing ? 'rgba(37, 99, 235, 0.04)' : 'rgba(37, 99, 235, 0.08)',
          color: '#2563eb',
          fontSize: 12,
          fontWeight: 600,
          cursor: installing ? 'wait' : 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        {installing ? (
          <>
            <RefreshCw size={12} className="spin" />
            Installing…
          </>
        ) : (
          '__TAURI__' in (typeof window !== 'undefined' ? window : {})
            ? 'Install & Restart'
            : 'Download'
        )}
      </button>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        style={{
          padding: 4,
          border: 'none',
          background: 'transparent',
          color: 'var(--t-text-muted)',
          cursor: 'pointer',
          borderRadius: 6,
        }}
        title="Dismiss"
      >
        <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}
