'use client';

import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { CliUpdateRecord } from '@/lib/setup/cli-updates';

const DISMISS_KEY = 'o8:codex-cli-update:dismissed';
const buttonStyle: CSSProperties = {
  height: 26, borderRadius: 7, border: 'none', fontSize: 11, fontWeight: 300,
  paddingLeft: 8, paddingRight: 8, paddingTop: 0, paddingBottom: 0,
  background: 'var(--t-input-bg)', color: 'var(--t-text)', cursor: 'pointer', fontFamily: 'inherit',
};

/** One cached release check per mount, with no background installation or polling. */
export function CodexCliUpdateNotice({ settings = false }: { settings?: boolean }) {
  const [tool, setTool] = useState<CliUpdateRecord | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [succeeded, setSucceeded] = useState(false);
  const [manual, setManual] = useState(false);
  const inFlight = useRef(false);

  useEffect(() => {
    let cancelled = false;
    try { setDismissed(localStorage.getItem(DISMISS_KEY)); } catch { /* storage unavailable */ }
    fetch('/api/setup/cli-updates?runtime=codex', { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) return;
        const data = await response.json() as { tools?: CliUpdateRecord[] };
        const codex = data.tools?.find((item) => item.runtimeId === 'codex');
        if (!cancelled && codex?.status === 'update-available') setTool(codex);
      }).catch(() => { /* An unknown release never becomes an update notice. */ });
    return () => { cancelled = true; };
  }, []);

  const update = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true); setMessage('Updating Codex. Checking the selected installation and runtime activity, then verifying its version…');
    try {
      const response = await fetch('/api/setup/cli-updates', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      const data = await response.json() as { status?: string; installedVersion?: string; error?: string; code?: string };
      if (!response.ok || data.status !== 'succeeded') {
        setManual(data.code === 'manual-update');
        throw new Error(data.error ?? 'Codex could not be updated. Check the selected installation before retrying.');
      }
      setSucceeded(true);
      setMessage(`Codex ${data.installedVersion} is installed and verified.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Codex could not be updated.');
    } finally {
      setPending(false); inFlight.current = false;
    }
  };

  if (!tool || (!settings && dismissed === tool.latestVersion)) return null;
  return (
    <div role="status" aria-live="polite" style={{
      marginLeft: 8, marginRight: 8, marginBottom: 6, flexShrink: 0,
      paddingTop: 9, paddingBottom: 9, paddingLeft: 11, paddingRight: 10,
      borderRadius: 10, border: '1px solid var(--t-divider-subtle)', background: 'var(--t-bg-card)',
      fontFamily: 'var(--font-sans-system)', color: 'var(--t-text)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11.5, fontWeight: 300, letterSpacing: '-0.1px' }}>{succeeded ? 'Codex updated' : 'Codex update available'}</div>
          <div style={{ marginTop: 4, fontSize: 9.5, fontWeight: 260, color: 'var(--t-text-muted)' }}>{tool.installedVersion} → {tool.latestVersion}</div>
        </div>
        {!succeeded && !manual ? <button type="button" style={buttonStyle} disabled={pending} onClick={() => { void update(); }}>{pending ? 'Updating…' : 'Update'}</button> : null}
        <button type="button" aria-label="Dismiss Codex update" style={buttonStyle} disabled={pending} onClick={() => {
          try { localStorage.setItem(DISMISS_KEY, tool.latestVersion ?? ''); } catch { /* storage unavailable */ }
          setDismissed(tool.latestVersion); setTool(null);
        }}>×</button>
      </div>
      {message ? <div style={{ marginTop: 8, fontSize: 11, fontWeight: 300, lineHeight: 1.4, color: 'var(--t-text-muted)' }}>{message}</div> : null}
      {manual ? <a href={tool.updateUrl} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-block', marginTop: 8, fontSize: 11, color: 'var(--t-text)' }}>Open Codex update instructions</a> : null}
    </div>
  );
}
