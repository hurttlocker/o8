'use client';

/**
 * BrowserPipCard — browser-specific content for the shared hover PiP shell.
 * Emitters dispatch BROWSER_PIP_EVENT; HoverPipCard owns visibility timing,
 * orientation, positioning, controls, and motion.
 */

import type { CSSProperties } from 'react';
import { useState } from 'react';
import { HoverPipCard } from '@/components/desktop/HoverPipCard';
import { NativeBrowserSurface } from '@/components/desktop/NativeBrowserSurface';
import { useO8BrowserTabs } from '@/components/desktop/use-o8-browser-tabs';
import { useNativeBrowserViewFlag } from '@/lib/operator/use-native-browser-view';
import { isTauri } from '@/lib/tauri/bridge';

export const BROWSER_PIP_EVENT = 'o8:browser-pip';

const ORIENTATION_KEY = 'o8:browser-pip-orientation';

export function BrowserPipCard({
  active,
  scopeKey,
  onOpenBrowser,
}: {
  /** No side panel is open — the only mode where the PIP earns its place. */
  active: boolean;
  /** MUST match the dashboard's browser tab-store scope (right-panel:<repo>). */
  scopeKey: string;
  onOpenBrowser?: () => void;
}) {
  const tabs = useO8BrowserTabs(scopeKey);
  const [inTauri] = useState<boolean>(() => isTauri());
  const nativeEnabled = useNativeBrowserViewFlag() && inTauri;
  const tab = tabs[0] ?? null;

  return (
    <HoverPipCard
      active={active}
      available={Boolean(tab)}
      eventName={BROWSER_PIP_EVENT}
      storageKey={ORIENTATION_KEY}
      title={tab?.title || tab?.host || tab?.url || ''}
      titleTooltip={tab?.url}
      openLabel="Open in Browser tab"
      onOpen={onOpenBrowser}
    >
      {({ shape, close }) => {
        if (!tab) return null;
        const iframeScale = shape.width / shape.viewport;

        return (
          <div style={{ position: 'relative', height: shape.frameHeight, overflow: 'hidden', background: 'var(--t-canvas-bg)' }}>
            {nativeEnabled ? (
              <NativeBrowserSurface url={tab.url} />
            ) : (
              <>
                <iframe
                  src={tab.url}
                  title="Browser preview"
                  sandbox="allow-scripts allow-same-origin allow-forms"
                  style={{
                    width: shape.viewport,
                    height: shape.frameHeight / iframeScale,
                    borderWidth: 0,
                    transform: `scale(${iframeScale})`,
                    transformOrigin: '0 0',
                    pointerEvents: 'none',
                  } as CSSProperties}
                />
                <button
                  type="button"
                  aria-label="Open browser tab"
                  onClick={() => {
                    close();
                    onOpenBrowser?.();
                  }}
                  style={{
                    position: 'absolute',
                    top: 0,
                    right: 0,
                    bottom: 0,
                    left: 0,
                    borderWidth: 0,
                    background: 'transparent',
                    cursor: 'pointer',
                  }}
                />
              </>
            )}
          </div>
        );
      }}
    </HoverPipCard>
  );
}
