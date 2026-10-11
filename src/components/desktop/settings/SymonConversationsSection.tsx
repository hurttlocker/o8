'use client';

import { useEffect, useRef, useState } from 'react';
import type { SymonConversationSummary, SymonTranscriptEntry } from '@/lib/symon/durable/brain';
import { SettingsGroup } from './grouped';
import { RamsButton } from './shared';

const SOURCE_LABELS = { messages: 'Messages', phone: 'Phone', voice: 'Voice', app: 'App' };

function isSummary(value: unknown): value is SymonConversationSummary {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<SymonConversationSummary>;
  return typeof row.key === 'string' && row.key.trim().length > 0 && row.key.length <= 320
    && typeof row.conversationId === 'string' && typeof row.title === 'string'
    && typeof row.source === 'string' && Object.hasOwn(SOURCE_LABELS, row.source)
    && typeof row.createdAt === 'number' && Number.isFinite(row.createdAt)
    && typeof row.updatedAt === 'number' && Number.isFinite(row.updatedAt);
}

function isTranscriptEntry(value: unknown): value is SymonTranscriptEntry {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<SymonTranscriptEntry>;
  return typeof row.id === 'string' && (row.role === 'user' || row.role === 'assistant') && typeof row.text === 'string';
}

export function SymonConversationsSection() {
  const [open, setOpen] = useState(false);
  const [conversations, setConversations] = useState<SymonConversationSummary[]>([]);
  const [selected, setSelected] = useState<SymonConversationSummary | null>(null);
  const [entries, setEntries] = useState<SymonTranscriptEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const backButton = useRef<HTMLButtonElement | null>(null);
  const restoreFocus = useRef(false);

  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (!open && restoreFocus.current) {
      backButton.current?.focus();
      restoreFocus.current = false;
    }
  }, [open]);

  async function load(thread: SymonConversationSummary | null) {
    controller.current?.abort();
    const active = new AbortController();
    controller.current = active;
    setOpen(true);
    setSelected(thread);
    setEntries([]);
    setBusy(true);
    setError(null);
    try {
      const url = thread
        ? `/api/panel/symon/conversations/transcript?key=${encodeURIComponent(thread.key)}&limit=100`
        : '/api/panel/symon/conversations?limit=50';
      const response = await fetch(url, { cache: 'no-store', signal: active.signal });
      const data = await response.json() as { ok?: boolean; key?: string; conversations?: SymonConversationSummary[]; transcript?: SymonTranscriptEntry[] };
      if (!response.ok || !data || !data.ok) throw new Error();
      if (thread
        ? data.key !== thread.key || !Array.isArray(data.transcript) || !data.transcript.every(isTranscriptEntry)
        : !Array.isArray(data.conversations) || !data.conversations.every(isSummary)) throw new Error();
      if (active.signal.aborted) return;
      if (thread) setEntries(data.transcript!);
      else setConversations(data.conversations!);
    } catch {
      if (!active.signal.aborted) setError(thread ? 'This conversation is unavailable.' : 'Saved conversations are unavailable.');
    } finally {
      if (!active.signal.aborted) setBusy(false);
    }
  }

  function close() {
    controller.current?.abort();
    restoreFocus.current = true;
    setOpen(false);
    setBusy(false);
    setError(null);
  }

  return (
    <section style={{ marginTop: 28, marginBottom: 28 }}>
      <SettingsGroup header="Symon conversations" footnote="Read saved conversations from Messages, phone, voice, and the app. Browsing history does not send a message or start a model turn.">
        <div style={{ paddingTop: 14, paddingRight: 14, paddingBottom: 14, paddingLeft: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <button ref={backButton} type="button" hidden={open} onClick={() => { void load(null); }} style={{ textAlign: 'left', border: 'none', background: 'transparent', color: 'var(--t-text)', fontFamily: 'inherit', fontSize: 13.5, fontWeight: 300, cursor: 'pointer', minHeight: 32 }}>Browse saved conversations</button>
          {open ? <>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {selected ? <RamsButton variant="ghost" onClick={() => { void load(null); }}>Back to conversations</RamsButton> : null}
              <RamsButton variant="ghost" disabled={busy} onClick={() => { void load(selected); }}>Refresh</RamsButton>
              <RamsButton variant="ghost" onClick={close}>Close history</RamsButton>
            </div>
            <p role={error ? 'alert' : 'status'} style={{ margin: 0, fontSize: 12, color: 'var(--t-text-muted)' }}>{busy ? 'Reading saved history…' : error ?? 'Read-only · 50 recent conversations · up to 100 recent transcript entries'}</p>
            {!busy && !error && !selected && !conversations.length ? <p style={{ margin: 0, fontSize: 13, color: 'var(--t-text-muted)' }}>No saved Symon conversations yet.</p> : null}
            {!busy && !error && !selected ? <div style={{ maxHeight: 320, overflowY: 'auto', scrollbarWidth: 'none' }}>
              {conversations.map((thread) => <button key={thread.key} type="button" onClick={() => { void load(thread); }} style={{ width: '100%', textAlign: 'left', display: 'block', background: 'transparent', border: 'none', borderRadius: 8, paddingTop: 8, paddingRight: 8, paddingBottom: 8, paddingLeft: 8, color: 'var(--t-text)', fontFamily: 'inherit', cursor: 'pointer', overflowWrap: 'anywhere' }}>
                <span style={{ display: 'block', fontSize: 13.5, fontWeight: 300 }}>{thread.title || 'Untitled conversation'}</span>
                <span style={{ display: 'block', marginTop: 4, fontSize: 9.5, fontWeight: 300, color: 'var(--t-text-muted)' }}>{SOURCE_LABELS[thread.source] ?? 'Other'} · {new Date(thread.updatedAt).toLocaleString()}</span>
              </button>)}
            </div> : null}
            {!busy && !error && selected ? <div tabIndex={0} aria-label="Saved conversation transcript" style={{ maxHeight: 440, overflowY: 'auto', scrollbarWidth: 'none', overflowWrap: 'anywhere', background: 'var(--t-chat-surface-bg)', color: 'var(--t-chat-surface-text)', borderRadius: 8, paddingTop: 12, paddingRight: 12, paddingBottom: 12, paddingLeft: 12 }}>
              <p style={{ margin: 0, fontSize: 13.5, fontWeight: 300 }}>{selected.title || 'Untitled conversation'}</p>
              <p style={{ marginTop: 4, fontSize: 11, color: 'var(--t-text-muted)' }}>{SOURCE_LABELS[selected.source]} · {new Date(selected.updatedAt).toLocaleString()}</p>
              {!entries.length ? <p style={{ fontSize: 13 }}>No saved text in this conversation.</p> : null}
              {entries.map((entry) => <article key={entry.id} style={{ marginTop: 16, minWidth: 0 }}>
                <div style={{ fontSize: 10, color: 'var(--t-text-muted)', marginBottom: 4 }}>{entry.role === 'user' ? 'You' : 'Symon'}</div>
                <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 13.5, fontWeight: 300, lineHeight: 1.5 }}>{entry.text}</div>
              </article>)}
            </div> : null}
          </> : null}
        </div>
      </SettingsGroup>
    </section>
  );
}
