'use client';

import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Download, RefreshCw } from '../lucide-shims';
import { FloatingSurface } from '../FloatingSurface';
import { ProviderMarkGlyph } from '../thoughts/composer-selector/provider-marks';
import { openExternalUrl } from '@/lib/desktop/open-external';
import { loadCachedReleaseNotes, refreshCliUpdateView, synchronizeConnectedClis, useUpdateHub } from '@/lib/app-update/update-hub-client';
import type { ReleaseNotes } from '@/lib/app-update/release-notes';
import { RailActionButton } from './RailActionButton';

const button: CSSProperties = { border: 0, borderRadius: 7, minHeight: 32, paddingTop: 6, paddingBottom: 6, paddingLeft: 12, paddingRight: 12,
  font: 'inherit', fontSize: 12, color: 'var(--t-text)', background: 'var(--t-hover)', cursor: 'pointer' };

export function RailUpdateControl({ buttonStyle }: { buttonStyle: CSSProperties }) {
  const hub = useUpdateHub();
  const id = useId();
  const trigger = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressFocusOpen = useRef(false);
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [position, setPosition] = useState({ left: 0, bottom: 0 });
  const [notes, setNotes] = useState<ReleaseNotes | null>(null);
  const [notesError, setNotesError] = useState(false);
  const pending = hub.app.installing || hub.syncing;
  const visibleTools = hub.tools.filter(tool => tool.runtimeId !== 'gemini' && tool.status !== 'not-installed');
  const available = Boolean(hub.app.version) || visibleTools.some(tool => tool.status === 'update-available');
  const cliUpdates = visibleTools.filter(tool => ['codex', 'claude-code', 'grok'].includes(tool.runtimeId) && tool.status === 'update-available');
  const cancel = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };
  const show = () => {
    cancel();
    void refreshCliUpdateView();
    const rect = trigger.current?.getBoundingClientRect();
    if (rect) setPosition({ left: Math.max(12, Math.min(rect.right + 14, window.innerWidth - 388)), bottom: Math.max(12, window.innerHeight - rect.bottom) });
    setOpen(true);
  };
  const close = () => { cancel(); setOpen(false); setPinned(false); };
  const leave = () => { cancel(); if (!pinned && !pending) timer.current = setTimeout(() => setOpen(false), 180); };
  useEffect(() => {
    let active = true;
    setNotes(null);
    setNotesError(false);
    void loadCachedReleaseNotes(hub.app.version ?? 'latest').then(value => { if (active) setNotes(value); })
      .catch(() => { if (active) setNotesError(true); });
    void refreshCliUpdateView();
    return () => { active = false; };
  }, [hub.app.version]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => { if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node) && !pending) close(); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') {
      event.preventDefault(); close(); suppressFocusOpen.current = true; trigger.current?.focus(); suppressFocusOpen.current = false;
    } };
    const reposition = () => { const rect = trigger.current?.getBoundingClientRect(); if (rect) setPosition({ left: Math.max(12, Math.min(rect.right + 14, window.innerWidth - 388)), bottom: Math.max(12, window.innerHeight - rect.bottom) }); };
    document.addEventListener('mousedown', outside); document.addEventListener('keydown', key); window.addEventListener('resize', reposition);
    return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', key); window.removeEventListener('resize', reposition); };
  // Closing timers are transient; the current pinned/pending state governs dismissal.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pending]);
  useEffect(() => {
    if (open && pinned) panel.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [open, pinned]);
  const check = () => { window.dispatchEvent(new Event('o8:check-all-updates')); void refreshCliUpdateView(true); };
  return <>
    <RailActionButton ref={trigger} type="button" aria-label="Updates" tooltipLabel={null} aria-haspopup="dialog"
      aria-expanded={open} aria-controls={open ? id : undefined} onMouseEnter={show} onMouseLeave={leave} onFocus={() => { if (!suppressFocusOpen.current) show(); }}
      onBlur={leave} onClick={() => { show(); setPinned(true); }} style={{ ...buttonStyle, flexShrink: 0 }}>
      <span aria-hidden="true" style={{ width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '50%', background: 'var(--t-hover)' }}><Download size={18} strokeWidth={1.7} /></span>
      {available ? <span data-update-dot aria-hidden="true" style={{ position: 'absolute', top: 7, right: 8, width: 6, height: 6, borderRadius: '50%', background: 'var(--t-accent)', boxShadow: '0 0 0 2px var(--t-bg)' }} /> : null}
    </RailActionButton>
    {open ? createPortal(<FloatingSurface ref={panel} id={id} role="dialog" aria-label="Updates and release notes" aria-modal="false"
      onMouseEnter={cancel} onMouseLeave={leave} onFocus={cancel}
      contentStyle={{ maxHeight: 'min(620px, calc(100vh - 24px))', overflowY: 'auto' }}
      style={{ position: 'fixed', ...position, width: 'min(372px, calc(100vw - 24px))', zIndex: 220 }}>
      <div style={{ padding: 18, display: 'grid', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div><div style={{ fontSize: 15, fontWeight: 500 }}>{hub.app.version ? 'Update ready' : 'Updates'}</div>
            <div style={{ marginTop: 4, fontSize: 11.5, color: 'var(--t-text-muted)' }}>{hub.app.version ? `o8 ${hub.app.version}`
              : hub.app.outcome === 'current' ? 'o8 is up to date' : 'o8 and connected CLIs'}</div></div>
          <button type="button" aria-label="Refresh updates" disabled={hub.checking || pending} onClick={check} style={{ ...button, width: 32, padding: 0 }}><RefreshCw size={14} strokeWidth={1.7} /></button>
        </div>
        {visibleTools.length ? <div style={{ display: 'grid', gap: 12, borderTop: '1px solid var(--t-divider-subtle)', paddingTop: 14 }}>
          {visibleTools.map(tool => <div key={tool.runtimeId} style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <span aria-hidden="true" style={{ width: 15, height: 15, display: 'inline-flex', flexShrink: 0 }}><ProviderMarkGlyph mark={tool.runtimeId === 'codex' ? 'openai' : tool.runtimeId === 'claude-code' ? 'anthropic' : tool.runtimeId === 'grok' ? 'x' : 'gemini'} size={15} /></span>
            <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 12.5 }}>{tool.label}</div><div style={{ fontSize: 10.5, color: 'var(--t-text-muted)', marginTop: 3 }}>{tool.installedVersion ?? 'Unknown version'}
              {tool.status === 'update-available' ? ` → ${tool.latestVersion}` : ''}{tool.manager ? ` · ${tool.manager === 'manual' ? 'original installer' : tool.manager}` : ''}</div>
              {tool.runtimeId === 'grok' && tool.manager === 'npm' && tool.status === 'update-available' ? <button type="button" onClick={() => openExternalUrl(tool.updateUrl)}
                style={{ ...button, marginTop: 4, minHeight: 20, padding: 0, background: 'transparent', color: 'var(--t-text-muted)', fontSize: 10.5, textDecoration: 'underline' }}>Use original npm updater</button> : null}</div>
            <span style={{ fontSize: 10.5, color: tool.status === 'update-available' ? 'var(--t-accent)' : 'var(--t-text-muted)' }}>{hub.cliBusy === tool.runtimeId ? 'Updating…'
              : tool.status === 'current' ? 'Current' : tool.status === 'update-available' ? 'Update ready' : 'Check unavailable'}</span>
          </div>)}
        </div> : null}
        {(hub.app.error || hub.app.message || hub.cliError) ? <div role={hub.app.error || hub.cliError ? 'alert' : 'status'} style={{ fontSize: 12, lineHeight: 1.5, color: hub.app.error || hub.cliError ? 'var(--t-danger)' : 'var(--t-text-secondary)' }}>{hub.cliError || hub.app.error || hub.app.message}</div> : null}
        {hub.app.version || cliUpdates.length ? <div style={{ display: 'grid', gap: 8 }}>
          <button type="button" disabled={pending} onClick={() => { setPinned(true); if (hub.app.version) window.dispatchEvent(new Event('o8:install-all-updates')); else void synchronizeConnectedClis().catch(() => {}); }}
            style={{ ...button, minHeight: 36, color: 'var(--t-accent-contrast, #fff)', background: 'var(--t-accent)', opacity: pending ? 0.65 : 1 }}>
            {pending ? 'Updating…' : hub.app.version ? hub.app.downloadOnly ? 'Download o8' : 'Update o8 and connected CLIs' : 'Update connected CLIs'}
          </button>
          <span style={{ fontSize: 10.5, lineHeight: 1.5, color: 'var(--t-text-muted)' }}>{hub.app.downloadOnly
            ? 'This o8 installation updates through its downloaded installer. Connected CLI updates can be run here separately.'
            : 'o8 updates also check installed Codex, Claude Code and Grok Build. Running sessions wait; your installer and release channel stay the same.'}</span>
          {hub.app.downloadOnly && cliUpdates.length ? <button type="button" disabled={pending} onClick={() => { setPinned(true); void synchronizeConnectedClis().catch(() => {}); }} style={button}>Update connected CLIs</button> : null}
        </div> : null}
        <section style={{ borderTop: '1px solid var(--t-divider-subtle)', paddingTop: 14 }}>
          <div style={{ fontSize: 12.5, fontWeight: 500 }}>{notes?.source === 'changelog' ? 'Latest published changes' : 'What’s changed'}</div>
          {notes?.source === 'changelog' ? <div style={{ fontSize: 10.5, marginTop: 5, color: 'var(--t-text-muted)' }}>From the dated public changelog · through {notes.publishedAt?.slice(0, 10) ?? 'the latest entry'}</div> : null}
          {notes?.entries.length ? <ul style={{ marginTop: 10, marginBottom: 10, paddingLeft: 17, display: 'grid', gap: 9, fontSize: 12, lineHeight: 1.6, color: 'var(--t-text-secondary)' }}>
            {notes.entries.map((entry, index) => <li key={index}>{entry.text}</li>)}
          </ul> : <p style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--t-text-muted)' }}>{notesError ? 'Published notes are unavailable right now. Open the release history for details.' : notes ? notes.summary : 'Loading published notes…'}</p>}
          <button type="button" onClick={() => openExternalUrl(notes?.releaseUrl ?? 'https://github.com/hurttlocker/o8-releases/releases')} style={{ ...button, minHeight: 24, paddingLeft: 0, paddingRight: 0, background: 'transparent', color: 'var(--t-text-muted)', textDecoration: 'underline', textUnderlineOffset: 3 }}>View release on GitHub</button>
        </section>
      </div>
    </FloatingSurface>, document.body) : null}
  </>;
}
