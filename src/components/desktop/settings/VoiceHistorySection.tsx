'use client';

/**
 * VoiceHistorySection — the dictation history panel (Symon parity).
 *
 * Shows recent system dictations + Ask questions (newest first) so the operator
 * can retrieve EXACTLY what they said when a paste landed in the wrong place.
 * Each row: mode + time + target app + the text, with copy / delete. Reads the
 * persisted store via the Tauri bridge; reloads on mount + window focus.
 *
 * Inline styles only, var(--t-*) tokens, raw-SVG icons (repo rule).
 */

import { useCallback, useEffect, useState } from 'react';
import {
  isTauri,
  dictationHistoryGet,
  dictationHistoryClear,
  dictationHistoryDelete,
  type DictationHistoryEntry,
} from '@/lib/tauri/bridge';
import {
  APP_FONT_STACK,
  MONO_FONT_STACK,
  RAMS_INK_QUIET,
  HairlineRule,
  RamsButton,
  SectionLabel,
} from './shared';

function relativeTime(tsSeconds: number): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const diff = Math.max(0, nowSec - tsSeconds);
  if (diff < 45) return 'just now';
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  const d = new Date(tsSeconds * 1000);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    + ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** Bundle id → a short readable app name (best effort). */
function appName(bundleId: string): string {
  if (!bundleId) return '';
  const parts = bundleId.split('.');
  const last = parts[parts.length - 1] || bundleId;
  return last.charAt(0).toUpperCase() + last.slice(1);
}

const MODE_LABEL: Record<string, string> = {
  dictation: 'DICTATION',
  ask: 'ASK',
  'speak-selection': 'SPOKEN',
};

function HistoryRow({
  entry,
  copied,
  onCopy,
  onDelete,
}: {
  entry: DictationHistoryEntry;
  copied: boolean;
  onCopy: (id: string, text: string) => void;
  onDelete: (id: string) => void;
}) {
  const [hover, setHover] = useState(false);
  const app = appName(entry.app);
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ position: 'relative', paddingTop: 12, paddingBottom: 12 }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
        <span
          style={{
            fontFamily: MONO_FONT_STACK,
            fontSize: 9,
            fontWeight: 400,
            letterSpacing: '0.08em',
            color: entry.mode === 'ask' ? '#8fb8ff' : RAMS_INK_QUIET,
          }}
        >
          {MODE_LABEL[entry.mode] ?? entry.mode.toUpperCase()}
        </span>
        <span style={{ fontSize: 11, fontWeight: 300, color: 'var(--t-text-faint)' }}>
          {relativeTime(entry.ts)}
        </span>
        {app ? (
          <span style={{ fontSize: 11, fontWeight: 300, color: 'var(--t-text-faint)' }}>· {app}</span>
        ) : null}
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 4, opacity: hover || copied ? 1 : 0, transition: 'opacity 0.16s ease' }}>
          <button
            type="button"
            aria-label={copied ? 'Copied' : 'Copy text'}
            onClick={() => onCopy(entry.id, entry.text)}
            style={{
              fontFamily: MONO_FONT_STACK,
              fontSize: 9.5,
              fontWeight: 400,
              letterSpacing: '0.04em',
              color: copied ? '#22c55e' : 'var(--t-text-secondary)',
              background: 'transparent',
              border: '1px solid var(--t-border)',
              borderRadius: 6,
              paddingTop: 2,
              paddingBottom: 2,
              paddingLeft: 7,
              paddingRight: 7,
              cursor: 'pointer',
            }}
          >
            {copied ? 'COPIED' : 'COPY'}
          </button>
          <button
            type="button"
            aria-label="Delete entry"
            onClick={() => onDelete(entry.id)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 22,
              height: 22,
              borderRadius: 6,
              border: '1px solid var(--t-border)',
              background: 'transparent',
              color: 'var(--t-text-faint)',
              cursor: 'pointer',
              padding: 0,
            }}
          >
            <svg width="11" height="11" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </span>
      </div>
      <div
        style={{
          fontSize: 13,
          fontWeight: 300,
          lineHeight: 1.5,
          color: 'var(--t-text)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          userSelect: 'text',
        }}
      >
        {entry.text}
      </div>
    </div>
  );
}

export function VoiceHistorySection() {
  const [entries, setEntries] = useState<DictationHistoryEntry[]>([]);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!isTauri()) return;
    setEntries(await dictationHistoryGet());
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Reload when the settings window regains focus (a dictation may have landed
  // while it was in the background).
  useEffect(() => {
    if (!isTauri()) return;
    const onFocus = () => { void load(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  const handleCopy = useCallback((id: string, text: string) => {
    if (!text.trim()) return;
    void navigator.clipboard?.writeText(text).catch(() => { /* noop */ });
    setCopiedId(id);
    setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1400);
  }, []);

  const handleDelete = useCallback(async (id: string) => {
    await dictationHistoryDelete(id);
    setEntries((prev) => prev.filter((e) => e.id !== id));
  }, []);

  const handleClear = useCallback(async () => {
    await dictationHistoryClear();
    setEntries([]);
  }, []);

  return (
    <section style={{ marginTop: 32, fontFamily: APP_FONT_STACK }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <SectionLabel number="05">HISTORY</SectionLabel>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 8 }}>
          <RamsButton variant="ghost" onClick={() => { void load(); }}>Refresh</RamsButton>
          {entries.length > 0 ? (
            <RamsButton variant="ghost" onClick={() => { void handleClear(); }}>Clear all</RamsButton>
          ) : null}
        </span>
      </div>
      <p
        style={{
          margin: 0,
          marginTop: 4,
          marginBottom: 8,
          fontSize: 13,
          lineHeight: 1.55,
          color: 'var(--t-text-secondary)',
          maxWidth: 620,
        }}
      >
        Everything you dictated or asked, newest first — your safety net when a paste lands in the
        wrong place. Stored locally on this Mac.
      </p>

      {entries.length === 0 ? (
        <p style={{ fontSize: 12.5, fontWeight: 300, color: 'var(--t-text-faint)', paddingTop: 8, paddingBottom: 8 }}>
          No dictations yet — hold Fn and speak, and they'll show up here.
        </p>
      ) : (
        <div
          style={{
            maxHeight: 400,
            overflowY: 'auto',
            marginTop: 4,
            paddingRight: 6,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {entries.map((entry, i) => (
            <div key={entry.id}>
              {i > 0 ? <HairlineRule /> : null}
              <HistoryRow
                entry={entry}
                copied={copiedId === entry.id}
                onCopy={handleCopy}
                onDelete={(id) => { void handleDelete(id); }}
              />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
