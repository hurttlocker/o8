'use client';

import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { motion, useReducedMotion } from 'framer-motion';
import { ChevronDown, Download, RefreshCw } from '../lucide-shims';
import { FloatingSurface } from '../FloatingSurface';
import { openExternalUrl } from '@/lib/desktop/open-external';
import { checkAllUpdates, loadCachedReleaseNotes, refreshCliUpdateView, synchronizeConnectedClis, useUpdateHub } from '@/lib/app-update/update-hub-client';
import { toast } from '@/components/shared/ConfirmToastHost';
import type { ReleaseNotes } from '@/lib/app-update/release-notes';
import { RailActionButton } from './RailActionButton';
import { ConnectedCliUpdateRows } from './ConnectedCliUpdateRows';

const button: CSSProperties = { border: 0, borderRadius: 7, minHeight: 32, paddingTop: 6, paddingBottom: 6, paddingLeft: 12, paddingRight: 12,
  font: 'inherit', fontSize: 12, color: 'var(--t-text)', background: 'var(--t-hover)', cursor: 'pointer' };

export function RailUpdateControl({ buttonStyle }: { buttonStyle: CSSProperties }) {
  const hub = useUpdateHub();
  const reducedMotion = useReducedMotion();
  const id = useId();
  const trigger = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressFocusOpen = useRef(false);
  const checkingRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [animateOpen, setAnimateOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [position, setPosition] = useState({ left: 0, bottom: 0 });
  const [notes, setNotes] = useState<ReleaseNotes | null>(null);
  const [notesError, setNotesError] = useState(false);
  const [currentExpanded, setCurrentExpanded] = useState(false);
  const [allNotes, setAllNotes] = useState(false);
  const pending = hub.app.installing || hub.syncing;
  const status = hub.cliMessage || hub.checkMessage || hub.app.message;
  const visibleTools = hub.tools.filter(tool => tool.runtimeId !== 'gemini' && tool.status !== 'not-installed');
  const available = Boolean(hub.app.version) || visibleTools.some(tool => tool.status === 'update-available');
  const cliUpdates = visibleTools.filter(tool => ['codex', 'claude-code', 'grok'].includes(tool.runtimeId) && tool.status === 'update-available');
  const actionTools = visibleTools.filter(tool => tool.status !== 'current');
  const currentTools = visibleTools.filter(tool => tool.status === 'current');
  const rawError = hub.cliError || hub.app.error;
  const error = rawError && /abort|timed?\s*out|failed to fetch|fetch is/i.test(rawError) ? 'Update checks couldn’t finish. Try again.' : rawError;
  const cancel = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };
  const show = (animate = false) => {
    if (checkingRef.current) return;
    cancel();
    if (!open) setAnimateOpen(animate);
    void refreshCliUpdateView();
    const rect = trigger.current?.getBoundingClientRect();
    if (rect) setPosition({ left: Math.max(12, Math.min(rect.right + 12, window.innerWidth - 356)), bottom: Math.max(12, window.innerHeight - rect.bottom) });
    setOpen(true);
  };
  const close = () => { cancel(); setOpen(false); setPinned(false); };
  const leave = () => { cancel(); if (!pinned && !pending) timer.current = setTimeout(() => setOpen(false), 180); };
  useEffect(() => {
    let active = true;
    setNotes(null);
    setNotesError(false);
    setAllNotes(false);
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
    const reposition = () => { const rect = trigger.current?.getBoundingClientRect(); if (rect) setPosition({ left: Math.max(12, Math.min(rect.right + 12, window.innerWidth - 356)), bottom: Math.max(12, window.innerHeight - rect.bottom) }); };
    document.addEventListener('mousedown', outside); document.addEventListener('keydown', key); window.addEventListener('resize', reposition);
    return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', key); window.removeEventListener('resize', reposition); };
  // Closing timers are transient; the current pinned/pending state governs dismissal.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pending]);
  useEffect(() => {
    if (open && pinned) panel.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [open, pinned]);
  const check = async (dismiss = false) => {
    if (checkingRef.current || pending) return;
    checkingRef.current = true;
    if (dismiss) close();
    toast('Checking o8 and connected CLIs…', 'info');
    try {
      const result = await checkAllUpdates();
      toast(result.hasUpdates ? result.incomplete ? 'Updates are ready. Some checks could not finish.' : 'Updates are ready. Hover over Updates to review them.'
        : result.incomplete ? 'Some update checks could not finish. Try again.' : 'o8 and connected CLIs are up to date.',
      result.incomplete && !result.hasUpdates ? 'error' : result.hasUpdates ? 'info' : 'success');
    } catch { toast('Update checks could not finish. Try again.', 'error'); }
    finally { checkingRef.current = false; }
  };
  return <>
    <RailActionButton ref={trigger} type="button" aria-label="Updates" tooltipLabel={null} aria-haspopup="dialog"
      aria-busy={hub.checkingAll || pending}
      aria-expanded={open} aria-controls={open ? id : undefined} onMouseEnter={() => show(true)} onMouseLeave={leave} onFocus={() => { if (!suppressFocusOpen.current) show(); }}
      onBlur={leave} disabled={pending || hub.checkingAll} onClick={() => { void check(true); }}
      onKeyDown={event => { if (event.key === 'ArrowUp') { event.preventDefault(); show(); setPinned(true); } }}
      aria-description="Click to check for updates. Hover or press Arrow Up to read release notes."
      style={{ ...buttonStyle, flexShrink: 0, cursor: pending || hub.checkingAll ? 'wait' : 'pointer' }}>
      <span data-update-ready={available || undefined} aria-hidden="true" style={{ width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center',
        borderRadius: '50%', color: available ? '#fff' : 'var(--t-text-muted)', background: available ? '#3b82f6' : 'transparent',
        transition: reducedMotion ? 'none' : 'background-color 160ms ease-out, color 160ms ease-out' }}><Download size={19} strokeWidth={1.8} /></span>
    </RailActionButton>
    {open ? createPortal(<motion.div initial={reducedMotion || !animateOpen ? false : { opacity: 0, x: -5, y: 3 }} animate={{ opacity: 1, x: 0, y: 0 }}
      transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }} style={{ position: 'fixed', ...position, width: 'min(340px, calc(100vw - 24px))', zIndex: 220 }}>
      <FloatingSurface ref={panel} id={id} role="dialog" aria-label="Updates and release notes" aria-modal="false"
      onMouseEnter={cancel} onMouseLeave={leave} onFocus={cancel}
      contentStyle={{ maxHeight: 'min(540px, calc(100vh - 24px))', overflowY: 'auto' }}>
      <div style={{ padding: 16, display: 'grid', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div><div style={{ fontSize: 14, fontWeight: 500 }}>{available ? 'Updates ready' : 'Updates'}</div>
            {hub.app.version ? <div style={{ marginTop: 3, fontSize: 11, color: 'var(--t-text-muted)' }}>o8 {hub.app.version}</div> : null}</div>
          <button type="button" aria-label="Refresh updates" disabled={hub.checking || hub.checkingAll || pending} onClick={() => { void check(); }} style={{ ...button, width: 32, padding: 0 }}><RefreshCw size={14} strokeWidth={1.7} /></button>
        </div>
        {actionTools.length ? <ConnectedCliUpdateRows tools={actionTools} busy={hub.cliBusy} disabled={pending || hub.checkingAll} onUpdate={runtime => { setPinned(true); void synchronizeConnectedClis(runtime).catch(() => {}); }} /> : null}
        {currentTools.length ? <div>
          <button type="button" aria-expanded={currentExpanded} aria-controls={`${id}-current`} onClick={() => setCurrentExpanded(value => !value)}
            style={{ ...button, minHeight: 26, width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: 0, background: 'transparent', color: 'var(--t-text-muted)', fontSize: 11 }}>
            <span>Current CLIs · {currentTools.length}</span><ChevronDown size={13} style={{ transform: currentExpanded ? 'rotate(180deg)' : undefined, transition: reducedMotion ? 'none' : 'transform 140ms ease-out' }} />
          </button>
          {currentExpanded ? <div id={`${id}-current`} style={{ paddingTop: 9 }}><ConnectedCliUpdateRows tools={currentTools} busy={hub.cliBusy} /></div> : null}
        </div> : null}
        {(error || status) ? <div role={error ? 'alert' : 'status'} style={{ fontSize: 11.5, lineHeight: 1.5, color: error ? 'var(--t-danger)' : 'var(--t-text-secondary)' }}>{error || status}</div> : null}
        {hub.app.version || cliUpdates.length ? <div style={{ display: 'grid', justifyItems: 'start', gap: 6 }}>
          {hub.app.version ? <button type="button" disabled={pending || hub.checkingAll}
            onClick={() => { setPinned(true); window.dispatchEvent(new Event('o8:install-app-update')); }}
            style={{ ...button, minHeight: 30, color: 'var(--t-accent-contrast, #fff)', background: 'var(--t-accent)', opacity: pending ? 0.65 : 1 }}>
            {hub.app.installing ? 'Updating o8…' : hub.app.downloadOnly ? 'Download o8' : 'Update o8'}
          </button> : null}
          {cliUpdates.length ? <button type="button" disabled={pending || hub.checkingAll}
            onClick={() => { setPinned(true); void synchronizeConnectedClis().catch(() => {}); }} style={button}>
            {hub.syncing ? 'Updating CLIs…' : 'Update connected CLIs'}
          </button> : null}
          <span style={{ fontSize: 10.5, lineHeight: 1.5, color: 'var(--t-text-muted)' }}>App and CLI updates are separate. Active sessions wait.</span>
        </div> : null}
        <section style={{ borderTop: '1px solid var(--t-divider-subtle)', paddingTop: 14 }}>
          <div style={{ fontSize: 12.5, fontWeight: 500 }}>{notes?.source === 'changelog' ? 'Latest published changes' : 'What’s changed'}</div>
          {notes?.source === 'changelog' && notes.publishedAt ? <div style={{ fontSize: 10.5, marginTop: 4, color: 'var(--t-text-muted)' }}>Published {notes.publishedAt.slice(0, 10)}</div> : null}
          {notes?.overview && notes.entries.length ? <p style={{ marginTop: 10, marginBottom: 10, fontSize: 12, lineHeight: 1.6, color: 'var(--t-text-secondary)' }}>{notes.overview}</p> : null}
          {notes?.entries.length ? <ul style={{ marginTop: 10, marginBottom: 10, paddingLeft: 17, display: 'grid', gap: 9, fontSize: 12, lineHeight: 1.6, color: 'var(--t-text-secondary)' }}>
            {notes.entries.slice(0, allNotes ? undefined : 5).map((entry, index) => <li key={index}>
              {entry.text.replace(/^(?:feat|fix|refactor|perf|chore|docs|style)(?:\([^)]*\))?:\s*/i, '')}
            </li>)}
          </ul> : <p style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--t-text-muted)' }}>{notesError ? 'Published notes are unavailable right now. Open the release history for details.' : notes ? notes.summary : 'Loading published notes…'}</p>}
          {notes && notes.entries.length > 5 ? <button type="button" aria-expanded={allNotes} onClick={() => setAllNotes(value => !value)}
            style={{ ...button, minHeight: 24, padding: 0, background: 'transparent', color: 'var(--t-text-secondary)', fontSize: 11 }}>
            {allNotes ? 'Show fewer changes' : `${notes.entries.length - 5} more changes`}
          </button> : null}
          <div><button type="button" onClick={() => openExternalUrl(notes?.releaseUrl ?? 'https://github.com/hurttlocker/o8-releases/releases')} style={{ ...button, minHeight: 24, paddingLeft: 0, paddingRight: 0, background: 'transparent', color: 'var(--t-text-muted)', fontSize: 10.5, textDecoration: 'underline', textUnderlineOffset: 3 }}>View release on GitHub</button></div>
        </section>
      </div>
    </FloatingSurface></motion.div>, document.body) : null}
  </>;
}
