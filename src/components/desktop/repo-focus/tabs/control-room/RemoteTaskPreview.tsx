'use client';

import { useEffect, useRef, useState } from 'react';
import { NativeRemotePreview } from '@/components/desktop/NativeRemotePreview';
import { isTauri } from '@/lib/tauri/bridge';
import { remotePreviewSupported } from '@/lib/tauri/remote-preview';
import { ActionButton } from './shared';
import { connectRemotePreview, type RemotePreviewAccess } from './remote-preview-client';

type Preview = RemotePreviewAccess & { id: string; url: string };

/** Native preview keeps untrusted project content out of the coordinator webview. */
export function RemoteTaskPreview({ taskId, jobId, attempt, onBack }: {
  taskId: string; jobId: string; attempt: number; onBack: () => void;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [connecting, setConnecting] = useState(true);
  const [stage, setStage] = useState('Checking preview support…');
  const serviceId = useRef<string | undefined>(undefined);
  const keepForReconnect = useRef(false);
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    let preserve = false;
    let opened: RemotePreviewAccess | null = serviceId.current ? { serviceJobId: serviceId.current } : null;
    const controller = new AbortController();
    const endpoint = `/api/tasks/${encodeURIComponent(taskId)}/preview`;
    const close = (access: RemotePreviewAccess, keepService = false) => {
      void fetch(endpoint, { method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: access.id, serviceJobId: access.serviceJobId, keepService }) }).catch(() => {});
    };
    void remotePreviewSupported().then(async (supported) => {
      if (!supported) throw new Error('Remote previews currently require the macOS desktop app.');
      if (!active) return;
      const body = await connectRemotePreview({ endpoint, jobId, attempt, serviceJobId: serviceId.current,
        signal: controller.signal, onAccess: (access) => {
          opened = access;
          if (active) {
            serviceId.current = access.serviceJobId;
            setStage(access.status === 'queued' ? 'Waiting for a remote worker…' : 'Starting the review service…');
          }
          else close(access, preserve);
        } });
      if (active) { setPreview(body as Preview); setError(null); }
    }).catch((reason: unknown) => {
      if (active) {
        if (opened) close(opened);
        serviceId.current = undefined;
        setError(reason instanceof Error ? reason.message : 'Remote preview is unavailable.');
      }
    }).finally(() => { if (active) setConnecting(false); });
    return () => {
      active = false; preserve = keepForReconnect.current; keepForReconnect.current = false;
      controller.abort();
      if (opened) close(opened, preserve);
      if (!preserve) serviceId.current = undefined;
    };
  }, [taskId, jobId, attempt, reload]);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 6, paddingRight: 6, paddingBottom: 6, paddingLeft: 6 }}>
      <div style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>Remote preview · attempt {attempt}{preview ? ` · ${preview.service}` : ''}</div>
      {!isTauri() ? <div>Open the preview in the desktop app.</div> : error ? <div role="alert">{error}</div> : !preview ? <div>{stage}</div> : (
        <div style={{ position: 'relative', height: 'min(380px, 52vh)', minHeight: 120, overflow: 'hidden', background: 'var(--t-canvas-bg)' }}>
          <NativeRemotePreview id={preview.id} url={preview.url} onError={setError} />
        </div>
      )}
      <div style={{ fontSize: 10.5, lineHeight: '15px', color: 'var(--t-text-faint)' }}>Read-only HTTP preview. Review services stop when you leave and expire after ten minutes. Streaming connections are not supported yet.</div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
        <ActionButton label="Back" onClick={onBack} />
        <ActionButton label={connecting ? 'Connecting…' : 'Reconnect'} disabled={connecting || !isTauri()} onClick={() => { keepForReconnect.current = true; setStage('Reconnecting to the service…'); setConnecting(true); setPreview(null); setError(null); setReload((value) => value + 1); }} />
      </div>
    </div>
  );
}
