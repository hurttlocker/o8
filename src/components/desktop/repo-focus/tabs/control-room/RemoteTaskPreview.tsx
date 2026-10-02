'use client';

import { useEffect, useState } from 'react';
import { NativeRemotePreview } from '@/components/desktop/NativeRemotePreview';
import { isTauri } from '@/lib/tauri/bridge';
import { remotePreviewSupported } from '@/lib/tauri/remote-preview';
import { ActionButton } from './shared';

interface Preview { id: string; url: string; service: string; jobId: string; attempt: number; }

/** Native preview keeps untrusted project content out of the coordinator webview. */
export function RemoteTaskPreview({ taskId, jobId, attempt, onBack }: {
  taskId: string; jobId: string; attempt: number; onBack: () => void;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [connecting, setConnecting] = useState(true);
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    let opened: Preview | null = null;
    const endpoint = `/api/tasks/${encodeURIComponent(taskId)}/preview`;
    const close = (id: string) => { void fetch(endpoint, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) }).catch(() => {}); };
    // A cancelled response may already own a listener. Read its id and close it
    // instead of abandoning an allocated preview socket on a client abort.
    void remotePreviewSupported().catch(() => { throw new Error('This native app needs an update to open isolated remote previews.'); })
      .then((supported) => {
        if (!supported) throw new Error('Remote previews currently require the macOS desktop app.');
        if (!active) throw new Error('Preview closed.');
        return fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', body: JSON.stringify({ jobId, attempt }) });
      })
      .then(async (response) => {
        const body = await response.json() as Preview & { error?: string };
        if (!response.ok) throw new Error(body.error || 'Remote preview is unavailable.');
        opened = body;
        if (!active) { close(body.id); return; }
        setPreview(body); setError(null);
      })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : 'Remote preview is unavailable.'); })
      .finally(() => { if (active) setConnecting(false); });
    return () => { active = false; if (opened) close(opened.id); };
  }, [taskId, jobId, attempt, reload]);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 6, paddingRight: 6, paddingBottom: 6, paddingLeft: 6 }}>
      <div style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>Remote preview · attempt {attempt}{preview ? ` · ${preview.service}` : ''}</div>
      {!isTauri() ? <div>Open the preview in the desktop app.</div> : error ? <div role="alert">{error}</div> : !preview ? <div>Connecting to the task service…</div> : (
        <div style={{ position: 'relative', height: 'min(380px, 52vh)', minHeight: 120, overflow: 'hidden', background: 'var(--t-canvas-bg)' }}>
          <NativeRemotePreview id={preview.id} url={preview.url} onError={setError} />
        </div>
      )}
      <div style={{ fontSize: 10.5, lineHeight: '15px', color: 'var(--t-text-faint)' }}>Read-only HTTP preview. Services stop when this execution ends; streaming connections are not supported yet.</div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
        <ActionButton label="Back" onClick={onBack} />
        <ActionButton label={connecting ? 'Connecting…' : 'Reconnect'} disabled={connecting || !isTauri()} onClick={() => { setConnecting(true); setPreview(null); setError(null); setReload((value) => value + 1); }} />
      </div>
    </div>
  );
}
