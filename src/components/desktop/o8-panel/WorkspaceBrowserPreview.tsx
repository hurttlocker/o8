'use client';

/**
 * WorkspaceBrowserPreview — live browser preview inside the workspace tab
 * (T3-Code borrow, 2026-07-31). When the operator has a browser tab open and
 * the screen is wide enough, the page shows right here above the diff — no
 * need to flip to the Browser tab to see what the agent is building.
 *
 * In Tauri this mounts a second NativeBrowserSurface host: the single native
 * child window hands off between the Browser tab's host and this one via the
 * existing IntersectionObserver/visibleRef arbitration (the two tabs are
 * mutually exclusive, so both hosts are never on screen at once). Unlike
 * T3's static thumbnail, the preview is the LIVE page.
 *
 * Outside Tauri (dev in a plain browser) it falls back to a half-scale
 * pointer-inert iframe — T3's actual mechanism — so the surface still paints.
 */

import { useEffect, useRef, useState } from 'react';
import { NativeBrowserSurface } from '@/components/desktop/NativeBrowserSurface';
import { useO8BrowserTabs } from '@/components/desktop/use-o8-browser-tabs';
import { useNativeBrowserViewFlag } from '@/lib/operator/use-native-browser-view';
import { isTauri } from '@/lib/tauri/bridge';

const COLLAPSED_KEY = 'o8:workspace-preview-collapsed';
/** "Screen is wide enough" — below this the preview would eat the center. */
const MIN_VIEWPORT_WIDTH = 1200;
const PREVIEW_HEIGHT = 240;
const FONT = 'var(--font-sans-system)';

export function WorkspaceBrowserPreview({
  active,
  suppressed = false,
  browserScopeKey,
  onOpenBrowser,
}: {
  /** Workspace tab is the active main tab. */
  active: boolean;
  /** A browser surface is already visible elsewhere (utility strip) — never
   *  mount a second visible host for the single native window. */
  suppressed?: boolean;
  /** MUST match the O8BrowserPane's stateScopeKey — the dashboard scopes the
   *  tab store per repo (right-panel:<repoPath>), not the bare default. */
  browserScopeKey?: string;
  onOpenBrowser?: () => void;
}) {
  const tabs = useO8BrowserTabs(browserScopeKey);
  const [inTauri] = useState<boolean>(() => isTauri());
  const nativeEnabled = useNativeBrowserViewFlag() && inTauri;
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try { return window.localStorage.getItem(COLLAPSED_KEY) === '1'; } catch { return false; }
  });
  const [wide, setWide] = useState<boolean>(() => (
    typeof window === 'undefined' ? false : window.innerWidth >= MIN_VIEWPORT_WIDTH
  ));
  const frameRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onResize = () => setWide(window.innerWidth >= MIN_VIEWPORT_WIDTH);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const toggleCollapsed = () => {
    setCollapsed((current) => {
      const next = !current;
      try { window.localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  };

  const tab = tabs[0] ?? null;
  if (!active || suppressed || !wide || !tab) return null;

  return (
    <div style={{ flexShrink: 0, borderBottom: '1px solid var(--t-divider)', fontFamily: FONT }}>
      <div style={{ display: 'flex', alignItems: 'center', minHeight: 31, paddingLeft: 12, paddingRight: 8 }}>
        <button
          type="button"
          onClick={() => onOpenBrowser?.()}
          title={tab.url}
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            alignItems: 'baseline',
            gap: 6,
            borderWidth: 0,
            background: 'transparent',
            cursor: onOpenBrowser ? 'pointer' : 'default',
            textAlign: 'left',
            paddingTop: 0,
            paddingRight: 0,
            paddingBottom: 0,
            paddingLeft: 0,
            fontFamily: FONT,
          }}
        >
          <span
            style={{
              fontSize: 10.5,
              fontWeight: 300,
              letterSpacing: '-0.1px',
              color: 'var(--t-text-muted)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {tab.title || tab.host || tab.url}
          </span>
          {tab.host && tab.title ? (
            <span
              style={{
                flexShrink: 0,
                fontSize: 9.5,
                fontWeight: 260,
                letterSpacing: '-0.4px',
                color: 'var(--t-text-faint)',
                whiteSpace: 'nowrap',
              }}
            >
              {tab.host}
            </span>
          ) : null}
        </button>
        <button
          type="button"
          onClick={toggleCollapsed}
          title={collapsed ? 'Show browser preview' : 'Hide browser preview'}
          style={{
            flexShrink: 0,
            minWidth: 24,
            minHeight: 24,
            borderWidth: 0,
            borderRadius: 6,
            background: 'transparent',
            color: 'var(--t-text-faint)',
            cursor: 'pointer',
            fontSize: 12,
            fontWeight: 300,
            fontFamily: FONT,
          }}
        >
          {collapsed ? '+' : '−'}
        </button>
      </div>
      {!collapsed ? (
        <div
          ref={frameRef}
          style={{ position: 'relative', height: PREVIEW_HEIGHT, overflow: 'hidden', background: 'var(--t-canvas-bg)' }}
        >
          {nativeEnabled ? (
            <NativeBrowserSurface url={tab.url} />
          ) : (
            <>
              <iframe
                src={tab.url}
                title="Workspace browser preview"
                sandbox="allow-scripts allow-same-origin allow-forms"
                style={{
                  width: '200%',
                  height: '200%',
                  borderWidth: 0,
                  transform: 'scale(0.5)',
                  transformOrigin: '0 0',
                  pointerEvents: 'none',
                } as React.CSSProperties}
              />
              <button
                type="button"
                aria-label="Open browser tab"
                onClick={() => onOpenBrowser?.()}
                style={{
                  position: 'absolute',
                  top: 0,
                  right: 0,
                  bottom: 0,
                  left: 0,
                  borderWidth: 0,
                  background: 'transparent',
                  cursor: onOpenBrowser ? 'pointer' : 'default',
                }}
              />
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
