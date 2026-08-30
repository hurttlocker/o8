'use client';

/**
 * History tab — everything you dictated or asked, newest first. The safety net
 * when a paste lands in the wrong place. Stored locally
 * (`~/.o8/dictation-history.json`); copy or delete per entry.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  dictationHistoryGet, dictationHistoryDelete, dictationHistoryClear,
  type DictationHistoryEntry,
} from '@/lib/tauri/bridge';
import {
  ACCENT_LIGHT, GLASS_BG_HOVER, GLASS_BORDER_SUBTLE, OK_GREEN, TEXT_PRIMARY, TEXT_TERTIARY, TRANS_FAST,
} from '../tokens';
import { SectionCard, SectionTitle, SectionHint, GhostButton, Icon, PageHeader } from '../primitives';
import { ICONS } from '../tokens';
import type { ReactNode } from 'react';

function IconBtn({ label, onClick, color, children }: { label: string; onClick: () => void; color: string; children: ReactNode }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button" aria-label={label} onClick={onClick}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, borderRadius: 7,
        border: `1px solid ${GLASS_BORDER_SUBTLE}`, background: hover ? GLASS_BG_HOVER : 'transparent',
        color: color === TEXT_TERTIARY && hover ? TEXT_PRIMARY : color, cursor: 'pointer', padding: 0,
        transition: `background ${TRANS_FAST}, color ${TRANS_FAST}`,
      }}
    >
      {children}
    </button>
  );
}

function relativeTime(tsSeconds: number): string {
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - tsSeconds);
  if (diff < 45) return 'just now';
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  const d = new Date(tsSeconds * 1000);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    + ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
function appName(bundleId: string): string {
  if (!bundleId) return '';
  const parts = bundleId.split('.');
  const last = parts[parts.length - 1] || bundleId;
  return last.charAt(0).toUpperCase() + last.slice(1);
}

export default function HistoryTab() {
  const [history, setHistory] = useState<DictationHistoryEntry[]>([]);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const load = useCallback(async () => { setHistory(await dictationHistoryGet()); }, []);
  useEffect(() => { void dictationHistoryGet().then(setHistory); }, []);
  useEffect(() => {
    const onFocus = () => { void load(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  const copy = (id: string, text: string) => {
    if (!text.trim()) return;
    void navigator.clipboard?.writeText(text).catch(() => { /* noop */ });
    setCopiedId(id);
    setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1400);
  };
  const del = async (id: string) => { await dictationHistoryDelete(id); setHistory((p) => p.filter((e) => e.id !== id)); };
  const clearAll = async () => { await dictationHistoryClear(); setHistory([]); };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <PageHeader icon={ICONS.clock} title="History" right={<>
        <GhostButton label="Refresh" onClick={() => { void load(); }} />
        {history.length > 0 ? <GhostButton label="Clear all" onClick={() => { void clearAll(); }} /> : null}
      </>} />
      <SectionCard>
        <SectionTitle icon={ICONS.clock}>Recent</SectionTitle>
        <SectionHint>Everything you dictated or asked, newest first. Stored locally on this Mac.</SectionHint>
        {history.length === 0 ? (
          <p style={{ fontSize: 12.5, color: TEXT_TERTIARY, paddingTop: 4, paddingBottom: 4 }}>
            No dictations yet — hold Fn and speak, and they&apos;ll show up here.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {history.map((entry, i) => (
              <HistoryRow
                key={entry.id} entry={entry} first={i === 0} copied={copiedId === entry.id}
                onCopy={() => copy(entry.id, entry.text)} onDelete={() => { void del(entry.id); }}
              />
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

function HistoryRow({ entry, first, copied, onCopy, onDelete }: {
  entry: DictationHistoryEntry; first: boolean; copied: boolean; onCopy: () => void; onDelete: () => void;
}) {
  const [hover, setHover] = useState(false);
  const app = appName(entry.app);
  return (
    <div
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ position: 'relative', paddingTop: 11, paddingBottom: 11, borderTop: first ? 'none' : `1px solid ${GLASS_BORDER_SUBTLE}` }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
        <span style={{ fontSize: 9, fontWeight: 500, letterSpacing: '0.08em', color: entry.mode === 'ask' ? ACCENT_LIGHT : TEXT_TERTIARY }}>
          {entry.mode.toUpperCase()}
        </span>
        <span style={{ fontSize: 11, color: TEXT_TERTIARY }}>{relativeTime(entry.ts)}</span>
        {app ? <span style={{ fontSize: 11, color: TEXT_TERTIARY }}>· {app}</span> : null}
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 5, opacity: hover || copied ? 1 : 0, transition: `opacity ${TRANS_FAST}` }}>
          <IconBtn label={copied ? 'Copied' : 'Copy text'} onClick={onCopy} color={copied ? OK_GREEN : TEXT_TERTIARY}>
            <Icon icon={copied ? ICONS.check : ICONS.copy} size={12.5} />
          </IconBtn>
          <IconBtn label="Delete entry" onClick={onDelete} color={TEXT_TERTIARY}>
            <Icon icon={ICONS.close} size={13} />
          </IconBtn>
        </span>
      </div>
      <div style={{ fontSize: 13, color: TEXT_PRIMARY, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', userSelect: 'text' }}>
        {entry.text}
      </div>
    </div>
  );
}
