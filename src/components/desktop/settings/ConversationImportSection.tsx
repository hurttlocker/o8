'use client';
import { useRef, useState } from 'react';
import type { ExtractedProfile } from '@/lib/connectors/chatgpt/types';
import { SettingsGroup } from './grouped';
import { RamsButton } from './shared';

export function ConversationImportSection() {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [profile, setProfile] = useState<ExtractedProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const importFile = async (file: File) => {
    setBusy(true); setError(null);
    try {
      const body = new FormData(); body.append('file', file);
      const response = await fetch('/api/connectors/chatgpt', { method: 'POST', body });
      const data = await response.json();
      if (!response.ok || !data.profile) throw new Error(data.error ?? 'Could not import this export. Try a ZIP or conversations JSON file.');
      setProfile(data.profile);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Import failed. Try again.'); }
    finally { setBusy(false); if (input.current) input.current.value = ''; }
  };
  return <SettingsGroup header="Conversation history">
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <p style={{ margin: 0, fontSize: 12, color: 'var(--t-text-secondary)', lineHeight: 1.6 }}>Optionally import a ChatGPT export to build a local profile of your topics, tools, and unfinished projects. In ChatGPT, use Settings → Data Controls → Export data.</p>
      <input ref={input} type="file" accept=".zip,.json" aria-label="Conversation export" disabled={busy} style={{ display: 'none' }} onChange={(event) => { const file = event.target.files?.[0]; if (file) void importFile(file); }} />
      <RamsButton disabled={busy} onClick={() => input.current?.click()}>{busy ? 'Importing history…' : 'Import conversation history'}</RamsButton>
      {error ? <p role="alert" style={{ fontSize: 12, color: 'var(--t-danger)', margin: 0 }}>{error}</p> : null}
      {profile ? <p role="status" style={{ fontSize: 12, margin: 0 }}>Imported {profile.conversationCount} conversations with {profile.topics.length} topics and {profile.unfinishedThreads.length} unfinished projects.</p> : null}
    </div>
  </SettingsGroup>;
}
