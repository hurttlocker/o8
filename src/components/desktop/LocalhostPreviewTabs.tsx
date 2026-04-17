'use client';

import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  PREVIEW_HOST_MESSAGE_SOURCE,
  PREVIEW_MESSAGE_SOURCE,
  PREVIEW_PROXY_ROUTE,
  type DetectedLocalhostPreview,
  type PreviewSelectionPayload,
} from '@/lib/panel/preview';

function CrosshairIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3" />
      <path d="M12 19v3" />
      <path d="M2 12h3" />
      <path d="M19 12h3" />
    </svg>
  );
}

function RefreshIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M21 12a9 9 0 1 1-3.2-6.9" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

function ExternalLinkIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M7 17 17 7" />
      <path d="M7 7h10v10" />
    </svg>
  );
}

function XIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

interface LocalhostPreviewTabsProps {
  previews: DetectedLocalhostPreview[];
  selectedPreviewId?: string | null;
  onSelectPreview: (previewId: string) => void;
  onClosePreview: (previewId: string) => void;
  onElementSelect?: (selection: PreviewSelectionPayload) => void;
}

export function LocalhostPreviewTabs({
  previews,
  selectedPreviewId,
  onSelectPreview,
  onClosePreview,
  onElementSelect,
}: LocalhostPreviewTabsProps) {
  const iframeRefs = useRef<Map<string, HTMLIFrameElement>>(new Map());
  const [selectionModes, setSelectionModes] = useState<Record<string, boolean>>({});
  const [refreshKeys, setRefreshKeys] = useState<Record<string, number>>({});

  const activePreview = useMemo(() => {
    if (previews.length === 0) {
      return null;
    }
    if (selectedPreviewId) {
      return previews.find((preview) => preview.id === selectedPreviewId) ?? previews[0];
    }
    return previews[0];
  }, [previews, selectedPreviewId]);

  const syncSelectionMode = useCallback((previewId: string, enabled: boolean) => {
    const iframe = iframeRefs.current.get(previewId);
    iframe?.contentWindow?.postMessage({
      source: PREVIEW_HOST_MESSAGE_SOURCE,
      type: 'selection-mode',
      enabled,
    }, window.location.origin);
  }, []);

  useEffect(() => {
    if (!activePreview) {
      return;
    }
    if (selectedPreviewId === activePreview.id) {
      return;
    }
    onSelectPreview(activePreview.id);
  }, [activePreview, onSelectPreview, selectedPreviewId]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) {
        return;
      }

      const data = event.data as {
        source?: string;
        type?: string;
        enabled?: boolean;
        selection?: PreviewSelectionPayload;
      };

      if (!data || data.source !== PREVIEW_MESSAGE_SOURCE) {
        return;
      }

      const matchingPreview = previews.find((preview) => iframeRefs.current.get(preview.id)?.contentWindow === event.source);
      if (!matchingPreview) {
        return;
      }

      if (data.type === 'ready') {
        syncSelectionMode(matchingPreview.id, Boolean(selectionModes[matchingPreview.id]));
        return;
      }

      if (data.type === 'selection-mode') {
        setSelectionModes((current) => ({
          ...current,
          [matchingPreview.id]: Boolean(data.enabled),
        }));
        return;
      }

      if (data.type === 'selection' && data.selection) {
        onElementSelect?.(data.selection);
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [onElementSelect, previews, selectionModes, syncSelectionMode]);

  if (!activePreview) {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: '0%',
        minHeight: 0,
        minWidth: 0,
        backgroundColor: 'var(--t-bg-subtle)',
      }}>
        <div style={{
          width: 42,
          height: 42,
          borderRadius: 14,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--t-text-muted)',
          backgroundColor: 'rgba(148,163,184,0.1)',
          marginBottom: 12,
        }}>
          <ExternalLinkIcon size={18} />
        </div>
        <div style={{
          fontSize: 14,
          fontWeight: 600,
          color: 'var(--t-text)',
          letterSpacing: '-0.01em',
          marginBottom: 6,
        }}>
          No live previews yet
        </div>
        <div style={{
          fontSize: 12,
          color: 'var(--t-text-muted)',
          maxWidth: 280,
          textAlign: 'center',
          lineHeight: 1.5,
        }}>
          Start a localhost app from the terminal workspace and Cortex will dock it here automatically.
        </div>
      </div>
    );
  }

  const normalizedUrl = activePreview.url.replace('0.0.0.0', 'localhost');
  const proxiedSrc = `${PREVIEW_PROXY_ROUTE}?url=${encodeURIComponent(normalizedUrl)}`;
  const isSelectionEnabled = Boolean(selectionModes[activePreview.id]);
  const refreshKey = refreshKeys[activePreview.id] ?? 0;

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      flexGrow: 1,
      flexShrink: 1,
      flexBasis: '0%',
      minHeight: 0,
      minWidth: 0,
      backgroundColor: 'var(--t-canvas-bg)',
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        minHeight: 36,
        maxHeight: 36,
        background: 'var(--t-panel-translucent)',
        backdropFilter: 'blur(20px) saturate(1.6)',
        WebkitBackdropFilter: 'blur(20px) saturate(1.6)',
        borderBottomWidth: 1,
        borderBottomStyle: 'solid',
        borderBottomColor: 'var(--t-divider)',
        overflowX: 'auto',
        overflowY: 'hidden',
      } as React.CSSProperties}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          flexGrow: 1,
          flexShrink: 1,
          flexBasis: '0%',
          minWidth: 0,
          paddingLeft: 8,
        }}>
          {previews.map((preview) => {
            const isActive = preview.id === activePreview.id;
            return (
              <button
                key={preview.id}
                type="button"
                onClick={() => onSelectPreview(preview.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  height: 28,
                  paddingTop: 0,
                  paddingRight: 10,
                  paddingBottom: 0,
                  paddingLeft: 10,
                  marginRight: 4,
                  borderRadius: 8,
                  borderWidth: 0,
                  backgroundColor: isActive ? 'var(--t-panel)' : 'transparent',
                  color: isActive ? 'var(--t-text)' : 'var(--t-text-secondary)',
                  cursor: 'pointer',
                  flexShrink: 0,
                  boxShadow: isActive ? 'var(--t-panel-shadow)' : 'none',
                }}
              >
                <span style={{
                  width: 7,
                  height: 7,
                  borderRadius: 999,
                  backgroundColor: '#22c55e',
                  flexShrink: 0,
                }} />
                <span style={{
                  fontSize: 12,
                  fontWeight: isActive ? 600 : 500,
                  letterSpacing: '-0.01em',
                  whiteSpace: 'nowrap',
                }}>
                  localhost:{preview.port}
                </span>
                <span
                  onClick={(event) => {
                    event.stopPropagation();
                    onClosePreview(preview.id);
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 16,
                    height: 16,
                    borderRadius: 4,
                    color: 'var(--t-text-muted)',
                  }}
                >
                  <XIcon size={10} />
                </span>
              </button>
            );
          })}
        </div>

        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          paddingRight: 8,
          paddingLeft: 8,
          flexShrink: 0,
        }}>
          <button
            type="button"
            onClick={() => {
              setSelectionModes((current) => {
                const nextEnabled = !current[activePreview.id];
                syncSelectionMode(activePreview.id, nextEnabled);
                return {
                  ...current,
                  [activePreview.id]: nextEnabled,
                };
              });
            }}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 24,
              paddingTop: 0,
              paddingRight: 9,
              paddingBottom: 0,
              paddingLeft: 9,
              borderRadius: 999,
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: isSelectionEnabled ? 'rgba(37,99,235,0.28)' : 'rgba(148,163,184,0.18)',
              backgroundColor: isSelectionEnabled ? 'rgba(37,99,235,0.08)' : 'rgba(255,255,255,0.82)',
              color: isSelectionEnabled ? '#1d4ed8' : '#475569',
              cursor: 'pointer',
              fontSize: 11,
              fontWeight: 600,
              flexShrink: 0,
            }}
            title={isSelectionEnabled ? 'Element selection is active' : 'Select an element in the preview'}
          >
            <CrosshairIcon />
            Select
          </button>

          <button
            type="button"
            onClick={() => {
              setRefreshKeys((current) => ({
                ...current,
                [activePreview.id]: (current[activePreview.id] ?? 0) + 1,
              }));
            }}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 24,
              height: 24,
              borderRadius: 6,
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: 'rgba(148,163,184,0.18)',
              backgroundColor: 'rgba(255,255,255,0.82)',
              color: '#475569',
              cursor: 'pointer',
              flexShrink: 0,
            }}
            title="Refresh preview"
          >
            <RefreshIcon />
          </button>

          <button
            type="button"
            onClick={() => window.open(normalizedUrl, '_blank')}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 24,
              height: 24,
              borderRadius: 6,
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: 'rgba(148,163,184,0.18)',
              backgroundColor: 'rgba(255,255,255,0.82)',
              color: '#475569',
              cursor: 'pointer',
              flexShrink: 0,
            }}
            title="Open in browser"
          >
            <ExternalLinkIcon />
          </button>
        </div>
      </div>

      <iframe
        key={`${activePreview.id}:${refreshKey}`}
        ref={(element) => {
          if (element) {
            iframeRefs.current.set(activePreview.id, element);
            return;
          }
          iframeRefs.current.delete(activePreview.id);
        }}
        src={proxiedSrc}
        title={`Preview localhost:${activePreview.port}`}
        onLoad={() => syncSelectionMode(activePreview.id, Boolean(selectionModes[activePreview.id]))}
        style={{
          borderWidth: 0,
          width: '100%',
          flexGrow: 1,
          flexShrink: 1,
          flexBasis: '0%',
          minHeight: 0,
          backgroundColor: 'var(--t-canvas-bg)',
        }}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      />
    </div>
  );
}
