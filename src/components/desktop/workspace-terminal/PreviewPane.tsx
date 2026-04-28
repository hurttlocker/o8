'use client';

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Crosshair, RefreshCw, X } from '../lucide-shims';
import type {
  LocalhostPreview,
  PreviewSelectionPayload,
} from '@/components/desktop/workspace-terminal/types';
import {
  PREVIEW_HOST_MESSAGE_SOURCE,
  PREVIEW_MESSAGE_SOURCE,
} from '@/lib/panel/preview';

interface PreviewToolbarProps {
  preview: LocalhostPreview;
  selectionEnabled: boolean;
  onToggleSelection: () => void;
  onRefresh: () => void;
  onClose: () => void;
}

function PreviewToolbar({
  preview,
  selectionEnabled,
  onToggleSelection,
  onRefresh,
  onClose,
}: PreviewToolbarProps) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        // Apple HIG 44pt hit-zone — toolbar holds three interactive controls
        // (Select / Refresh / Close), each needs a 44x44 region.
        height: 44,
        minHeight: 44,
        paddingLeft: 12,
        paddingRight: 8,
        background: 'var(--t-bg-subtle)',
        borderBottomWidth: 1,
        borderBottomStyle: 'solid',
        borderBottomColor: 'var(--t-divider)',
        gap: 8,
        flexShrink: 0,
      }}
    >
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e', flexShrink: 0 }} />
      <span
        style={{
          fontSize: 11,
          color: '#64748b',
          fontFamily: 'ui-monospace, "SF Mono", Monaco, Menlo, monospace',
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {preview.url}
      </span>
      <button
        type="button"
        onClick={onToggleSelection}
        title={selectionEnabled ? 'Element selection is active' : 'Select an element in the preview'}
        style={{
          position: 'relative',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          height: 24,
          paddingTop: 0,
          paddingBottom: 0,
          paddingLeft: 9,
          paddingRight: 9,
          borderRadius: 999,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: selectionEnabled ? 'rgba(37,99,235,0.28)' : 'rgba(148,163,184,0.18)',
          background: selectionEnabled ? 'rgba(37,99,235,0.08)' : 'var(--t-bg-card)',
          color: selectionEnabled ? '#1d4ed8' : '#475569',
          cursor: 'pointer',
          fontSize: 11,
          fontWeight: 600,
          flexShrink: 0,
        }}
      >
        <span aria-hidden="true" style={previewHitZoneStyle} />
        <Crosshair size={12} />
        Select
      </button>
      <button
        type="button"
        onClick={onRefresh}
        title="Refresh"
        style={previewIconButtonStyle}
      >
        <span aria-hidden="true" style={previewHitZoneStyle} />
        <RefreshCw size={14} />
      </button>
      <button
        type="button"
        onClick={onClose}
        title="Close preview"
        style={previewIconButtonStyle}
      >
        <span aria-hidden="true" style={previewHitZoneStyle} />
        <X size={14} />
      </button>
    </div>
  );
}

// Visible toolbar buttons stay at 24x24 to fit the 32px preview strip; the
// transparent overlay below expands the click region to 44x44 for HIG.
const previewIconButtonStyle = {
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 24,
  height: 24,
  borderWidth: 0,
  borderStyle: 'none',
  background: 'transparent',
  color: '#64748b',
  cursor: 'pointer',
  borderRadius: 4,
} as const;

const previewHitZoneStyle = {
  position: 'absolute',
  top: '50%',
  left: '50%',
  width: 44,
  height: 44,
  transform: 'translate(-50%, -50%)',
  background: 'transparent',
} as const;

interface PreviewPaneProps {
  previews: LocalhostPreview[];
  onElementSelect?: (selection: PreviewSelectionPayload) => void;
  onRefresh: (id: string) => void;
  onClose: (id: string) => void;
}

export const PreviewPane = memo(function PreviewPane({
  previews,
  onElementSelect,
  onRefresh,
  onClose,
}: PreviewPaneProps) {
  const iframeRefs = useRef<Map<string, HTMLIFrameElement>>(new Map());
  const [selectionModes, setSelectionModes] = useState<Record<string, boolean>>({});

  const syncSelectionMode = useCallback((previewId: string, enabled: boolean) => {
    const iframe = iframeRefs.current.get(previewId);
    iframe?.contentWindow?.postMessage({
      source: PREVIEW_HOST_MESSAGE_SOURCE,
      type: 'selection-mode',
      enabled,
    }, window.location.origin);
  }, []);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as {
        source?: string;
        type?: string;
        enabled?: boolean;
        selection?: PreviewSelectionPayload;
      };
      if (!data || data.source !== PREVIEW_MESSAGE_SOURCE) return;

      const preview = previews.find((item) => iframeRefs.current.get(item.id)?.contentWindow === event.source);
      if (!preview) return;

      if (data.type === 'ready') {
        syncSelectionMode(preview.id, Boolean(selectionModes[preview.id]));
        return;
      }

      if (data.type === 'selection-mode') {
        setSelectionModes((previous) => ({ ...previous, [preview.id]: Boolean(data.enabled) }));
        return;
      }

      if (data.type === 'selection' && data.selection) {
        onElementSelect?.(data.selection);
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [onElementSelect, previews, selectionModes, syncSelectionMode]);

  if (previews.length === 0) return null;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        flex: 1,
        minHeight: 0,
        gap: 1,
        background: 'var(--t-divider-strong)',
      }}
    >
      {previews.map((preview) => (
        <div
          key={preview.id}
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            minWidth: 0,
            background: 'var(--t-panel)',
          }}
        >
          <PreviewToolbar
            preview={preview}
            selectionEnabled={Boolean(selectionModes[preview.id])}
            onToggleSelection={() => {
              setSelectionModes((previous) => {
                const enabled = !previous[preview.id];
                syncSelectionMode(preview.id, enabled);
                return { ...previous, [preview.id]: enabled };
              });
            }}
            onRefresh={() => {
              const iframe = iframeRefs.current.get(preview.id);
              if (iframe) {
                const src = iframe.src;
                iframe.src = '';
                setTimeout(() => {
                  iframe.src = src;
                }, 50);
              }
              onRefresh(preview.id);
            }}
            onClose={() => onClose(preview.id)}
          />
          <iframe
            ref={(element) => {
              if (element) iframeRefs.current.set(preview.id, element);
              else iframeRefs.current.delete(preview.id);
            }}
            src={`/api/panel/proxy?url=${encodeURIComponent(preview.url.replace('0.0.0.0', 'localhost'))}`}
            title={`Preview ${preview.url}`}
            onLoad={() => syncSelectionMode(preview.id, Boolean(selectionModes[preview.id]))}
            style={{ flex: 1, border: 'none', width: '100%', background: '#ffffff' }}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          />
        </div>
      ))}
    </div>
  );
});
