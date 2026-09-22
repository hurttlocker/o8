'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { isNonMacShell } from '@/lib/desktop/host-platform';
import { isTauri, voicePrefsGet, voicePrefsSet } from '@/lib/tauri/bridge';
import {
  APP_FONT_STACK,
  MONO_FONT_STACK,
  RAMS_ACCENT,
  RAMS_HAIRLINE_SOFT,
  RAMS_INK_QUIET,
  BracketLabel,
  RamsButton,
  FieldLabel,
  HairlineRule,
  TabHeading,
  SETTINGS_CONTENT_MAX_WIDTH,
} from './shared';

import { GroupHeader } from './grouped';

// ── Types ──

interface ProviderKeyInfo {
  id: string;
  label: string;
  envVar: string;
  placeholder: string;
  docsUrl: string;
  configured: boolean;
  maskedKey: string | null;
}

interface NativeKeyConfig {
  id: string;
  label: string;
  envVar: string;
  placeholder: string;
  docsUrl: string;
  description: string;
}

const NATIVE_KEYS: NativeKeyConfig[] = [
  {
    id: 'gemini_api_key',
    label: 'Gemini (Symon & voice)',
    envVar: 'GEMINI_API_KEY',
    placeholder: 'AIza...',
    docsUrl: 'https://aistudio.google.com/app/apikey',
    description: 'Direct Gemini access for Symon and dictation polish. A managed plan route remains available when your plan includes it.',
  },
  {
    id: 'openrouter_api_key',
    label: 'OpenRouter (Symon & voice)',
    envVar: 'OPENROUTER_API_KEY',
    placeholder: 'sk-or-...',
    docsUrl: 'https://openrouter.ai/keys',
    description: 'Direct OpenRouter access for Symon and cloud transcription. This is the native Keychain slot, separate from the app-services key above.',
  },
  {
    id: 'groq_api_key',
    label: 'Groq transcription',
    envVar: 'GROQ_API_KEY',
    placeholder: 'gsk_...',
    docsUrl: 'https://console.groq.com/keys',
    description: 'Direct Groq access for fast cloud transcription.',
  },
  {
    id: 'elevenlabs_api_key',
    label: 'ElevenLabs voice',
    envVar: 'ELEVENLABS_API_KEY',
    placeholder: 'your ElevenLabs key',
    docsUrl: 'https://elevenlabs.io/app/settings/api-keys',
    description: 'Direct ElevenLabs access for Symon read-aloud and Ask voices.',
  },
  {
    id: 'google_tts_api_key',
    label: 'Google Cloud TTS',
    envVar: 'GOOGLE_TTS_API_KEY',
    placeholder: 'your Google Cloud TTS key',
    docsUrl: 'https://console.cloud.google.com/apis/credentials',
    description: 'Direct Google Cloud Text-to-Speech access for voice output.',
  },
];

// Provider keys use the existing encrypted key store.

export function ApiKeysProviderList() {
  const [providers, setProviders] = useState<ProviderKeyInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ provider: string; type: 'success' | 'error'; message: string } | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const loadKeys = useCallback(async () => {
    if (mountedRef.current) {
      setLoading(true);
      setLoadError(null);
    }
    try {
      const res = await fetch('/api/v2/keys');
      if (!res.ok) throw new Error(`API key inventory returned ${res.status}.`);
      const data = await res.json() as { providers?: ProviderKeyInfo[] };
      if (!Array.isArray(data.providers)) throw new Error('API key inventory was unavailable.');
      if (mountedRef.current) setProviders(data.providers);
    } catch (error) {
      if (mountedRef.current) {
        setProviders([]);
        setLoadError(error instanceof Error ? error.message : 'Could not load API keys.');
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadKeys();
  }, [loadKeys]);

  const handleSave = useCallback(async (providerId: string) => {
    if (!keyInput.trim()) return;
    setSaving(true);
    try {
      const res = await fetch('/api/v2/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: providerId, key: keyInput.trim() }),
      });
      const data = await res.json();
      if (res.ok) {
        setFeedback({ provider: providerId, type: 'success', message: 'Saved. Active immediately.' });
        setEditingProvider(null);
        setKeyInput('');
        void loadKeys();
      } else {
        setFeedback({ provider: providerId, type: 'error', message: data.error || 'Failed to save' });
      }
    } catch {
      setFeedback({ provider: providerId, type: 'error', message: 'Network error' });
    }
    setSaving(false);
    setTimeout(() => setFeedback(null), 4000);
  }, [keyInput, loadKeys]);

  const handleRemove = useCallback(async (providerId: string) => {
    setSaving(true);
    try {
      const res = await fetch('/api/v2/keys', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: providerId }),
      });
      if (res.ok) {
        setFeedback({ provider: providerId, type: 'success', message: 'Removed.' });
        void loadKeys();
      }
    } catch { /* ignore */ }
    setSaving(false);
    setTimeout(() => setFeedback(null), 4000);
  }, [loadKeys]);

  if (loading) {
    return (
      <div style={{
        paddingTop: 8,
        paddingBottom: 8,
        color: 'var(--t-text-muted)',
        fontSize: 13,
        fontFamily: APP_FONT_STACK,
      }}>
        Loading API keys...
      </div>
    );
  }

  if (loadError) {
    return (
      <div role="alert" style={{ borderTop: `1px solid ${RAMS_HAIRLINE_SOFT}`, borderBottom: `1px solid ${RAMS_HAIRLINE_SOFT}`, paddingTop: 16, paddingBottom: 16 }}>
        <div style={{ fontSize: 13, color: '#dc2626', lineHeight: 1.5 }}>{loadError}</div>
        <button type="button" onClick={() => { void loadKeys(); }} style={{ ...quietLinkStyle(false), marginTop: 10 }}>retry</button>
      </div>
    );
  }

  return (
    <div style={{
      borderTop: `1px solid ${RAMS_HAIRLINE_SOFT}`,
    }}>
      {providers.map((p) => {
        const isEditing = editingProvider === p.id;
        const fb = feedback?.provider === p.id ? feedback : null;

        return (
          <div
            key={p.id}
            style={{
              borderBottom: `1px solid ${RAMS_HAIRLINE_SOFT}`,
              paddingTop: 16,
              paddingBottom: 16,
              paddingLeft: 2,
              paddingRight: 2,
            }}
          >
            <div style={{
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'space-between',
              gap: 14,
              flexWrap: 'wrap',
            }}>
              <div style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                minWidth: 0,
                flex: '1 1 360px',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <span style={{
                    fontSize: 15,
                    fontWeight: 300,
                    color: 'var(--t-text)',
                    letterSpacing: '-0.01em',
                  }}>
                    {p.id === 'openrouter' ? 'OpenRouter (app services)' : p.label}
                  </span>
                  <BracketLabel tone={p.configured ? 'quiet' : 'accent'}>
                    {p.configured ? 'configured' : 'missing'}
                  </BracketLabel>
                  <span style={{
                    fontFamily: MONO_FONT_STACK,
                    fontSize: 10,
                    fontWeight: 400,
                    letterSpacing: '0.12em',
                    color: RAMS_INK_QUIET,
                  }}>
                    {p.envVar}
                  </span>
                </div>

                <div style={{
                  fontSize: 13,
                  color: 'var(--t-text-secondary)',
                  lineHeight: 1.55,
                  maxWidth: 520,
                }}>
                  {p.configured
                    ? 'Saved for app services on this machine.'
                    : 'Add a direct provider key for app services on this installation.'}
                </div>

                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 16,
                  flexWrap: 'wrap',
                }}>
                  {p.configured && p.maskedKey ? (
                    <span style={{
                      fontFamily: MONO_FONT_STACK,
                      fontSize: 12,
                      fontWeight: 400,
                      color: 'var(--t-text-secondary)',
                      letterSpacing: '0.04em',
                    }}>
                      {p.maskedKey}
                    </span>
                  ) : (
                    <span style={{
                      fontFamily: APP_FONT_STACK,
                      fontSize: 12,
                      fontWeight: 400,
                      color: RAMS_INK_QUIET,
                      letterSpacing: '-0.01em',
                    }}>
                      not configured
                    </span>
                  )}
                  <a
                    href={p.docsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      minHeight: 32,
                      fontFamily: APP_FONT_STACK,
                      fontSize: 12,
                      fontWeight: 400,
                      color: 'var(--t-text-muted)',
                      textDecoration: 'underline',
                      textDecorationColor: RAMS_HAIRLINE_SOFT,
                      textUnderlineOffset: 3,
                    }}
                  >
                    get key ›
                  </a>
                </div>
              </div>

              {!isEditing ? (
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 20,
                  flexWrap: 'wrap',
                }}>
                  <button
                    type="button"
                    onClick={() => { setEditingProvider(p.id); setKeyInput(''); }}
                    style={accentLinkStyle(false)}
                  >
                    {p.configured ? 'update key' : 'add key'}
                  </button>
                  {p.configured ? (
                    <button
                      type="button"
                      onClick={() => { void handleRemove(p.id); }}
                      disabled={saving}
                      style={quietLinkStyle(saving)}
                    >
                      remove
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>

            {/* Inline editor */}
            {isEditing ? (
              <div style={{
                marginTop: 16,
                paddingTop: 14,
                borderTop: `1px solid ${RAMS_HAIRLINE_SOFT}`,
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
                maxWidth: 620,
              }}>
                <FieldLabel>paste {p.label.toLowerCase()} key</FieldLabel>
                <input
                  type="password"
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleSave(p.id);
                    if (e.key === 'Escape') setEditingProvider(null);
                  }}
                  placeholder={p.placeholder}
                  autoFocus
                  style={{
                    fontFamily: MONO_FONT_STACK,
                    fontSize: 13,
                    fontWeight: 400,
                    letterSpacing: '0.02em',
                    color: 'var(--t-text)',
                    background: 'transparent',
                    border: 'none',
                    borderBottom: `1px solid ${RAMS_HAIRLINE_SOFT}`,
                    paddingTop: 6,
                    paddingBottom: 8,
                    paddingLeft: 0,
                    paddingRight: 0,
                    outline: 'none',
                    width: '100%',
                  }}
                  onFocus={(e) => {
                    e.currentTarget.style.borderBottomColor = RAMS_ACCENT;
                  }}
                  onBlur={(e) => {
                    e.currentTarget.style.borderBottomColor = RAMS_HAIRLINE_SOFT;
                  }}
                />
                <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'center' }}>
                  <button
                    type="button"
                    onClick={() => { void handleSave(p.id); }}
                    disabled={!keyInput.trim() || saving}
                    style={accentLinkStyle(!keyInput.trim() || saving)}
                  >
                    {saving ? 'saving...' : 'save key'}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setEditingProvider(null); setKeyInput(''); }}
                    style={quietLinkStyle(false)}
                  >
                    cancel
                  </button>
                </div>
                <div style={{
                  fontSize: 12,
                  color: 'var(--t-text-muted)',
                  lineHeight: 1.55,
                }}>
                  Encrypted and written to{' '}
                  <span style={{
                    fontFamily: MONO_FONT_STACK,
                    fontSize: 11,
                    letterSpacing: '0.04em',
                    color: 'var(--t-text-secondary)',
                  }}>
                    ~/.o8/.env.local
                  </span>
                  {' '}and available right away.
                </div>
              </div>
            ) : null}

            {/* Feedback */}
            {fb ? (
              <div style={{
                marginTop: 10,
                fontSize: 12,
                fontFamily: APP_FONT_STACK,
                fontWeight: 400,
                letterSpacing: '-0.01em',
                color: fb.type === 'success' ? '#15803d' : '#dc2626',
              }}>
                {fb.message}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function NativeKeysList() {
  const nativeKeychain = isTauri() && !isNonMacShell();
  const [presence, setPresence] = useState<Record<string, boolean>>({});
  const [removingKey, setRemovingKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(nativeKeychain);
  const [bridgeAvailable, setBridgeAvailable] = useState(nativeKeychain);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ key: string; type: 'success' | 'error'; message: string } | null>(null);

  const loadPresence = useCallback(async () => {
    if (!nativeKeychain) return {};
    try {
      const prefs = await voicePrefsGet();
      if (!prefs) throw new Error('Could not read desktop key status.');
      const next = Object.fromEntries(
        NATIVE_KEYS.map((key) => [key.id, prefs[`${key.id}_set`] === true]),
      );
      setPresence(next);
      setBridgeAvailable(true);
      return next;
    } catch (error) {
      setPresence({});
      setBridgeAvailable(false);
      throw error;
    }
  }, [nativeKeychain]);

  useEffect(() => {
    let active = true;
    if (!nativeKeychain) return undefined;
    void loadPresence()
      .catch((error) => {
        if (active) {
          setPresence({});
          setBridgeAvailable(false);
          setFeedback({ key: 'all', type: 'error', message: error instanceof Error ? error.message : 'Could not read desktop key status.' });
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [nativeKeychain, loadPresence]);

  const saveKey = useCallback(async (key: NativeKeyConfig) => {
    const value = keyInput.trim();
    if (!value) return;
    setSavingKey(key.id);
    try {
      await voicePrefsSet(key.id, value);
      const next = await loadPresence();
      if (!next[key.id]) throw new Error('Keychain readback did not confirm the saved key.');
      setEditingKey(null);
      setKeyInput('');
      setFeedback({ key: key.id, type: 'success', message: 'Saved in macOS Keychain.' });
    } catch (error) {
      setFeedback({
        key: key.id,
        type: 'error',
        message: error instanceof Error ? error.message : 'Could not save this key.',
      });
    } finally {
      setSavingKey(null);
    }
  }, [keyInput, loadPresence]);

  const removeKey = useCallback(async (key: NativeKeyConfig) => {
    setSavingKey(key.id);
    try {
      await voicePrefsSet(key.id, '');
      const next = await loadPresence();
      if (next[key.id]) throw new Error('Keychain readback still reports a saved key.');
      setRemovingKey(null);
      setFeedback({ key: key.id, type: 'success', message: 'Removed from macOS Keychain.' });
    } catch (error) {
      setFeedback({
        key: key.id,
        type: 'error',
        message: error instanceof Error ? error.message : 'Could not remove this key.',
      });
    } finally {
      setSavingKey(null);
    }
  }, [loadPresence]);

  if (loading) {
    return <div style={{ paddingTop: 8, paddingBottom: 8, color: 'var(--t-text-muted)', fontSize: 13 }}>Loading desktop key status...</div>;
  }

  return (
    <div style={{ borderTop: `1px solid ${RAMS_HAIRLINE_SOFT}` }}>
      {feedback?.key === 'all' ? (
        <p role="status" style={{ fontSize: 12, color: '#dc2626' }}>{feedback.message}</p>
      ) : null}
      {NATIVE_KEYS.map((key) => {
        const configured = presence[key.id] === true;
        const editing = editingKey === key.id;
        const busy = savingKey === key.id;
        const rowFeedback = feedback?.key === key.id ? feedback : null;
        return (
          <div key={key.id} style={{ borderBottom: `1px solid ${RAMS_HAIRLINE_SOFT}`, paddingTop: 16, paddingBottom: 16, paddingLeft: 2, paddingRight: 2 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, flex: '1 1 360px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 15, fontWeight: 300, color: 'var(--t-text)', letterSpacing: '-0.01em' }}>{key.label}</span>
                  <BracketLabel tone={nativeKeychain && bridgeAvailable && configured ? 'quiet' : 'accent'}>
                    {!nativeKeychain ? 'macOS only' : !bridgeAvailable ? 'unavailable' : configured ? 'saved here' : 'not saved here'}
                  </BracketLabel>
                  <span style={{ fontFamily: MONO_FONT_STACK, fontSize: 10, fontWeight: 400, letterSpacing: '0.12em', color: RAMS_INK_QUIET }}>{key.envVar}</span>
                </div>
                <div style={{ fontSize: 13, color: 'var(--t-text-secondary)', lineHeight: 1.55, maxWidth: 560 }}>{key.description}</div>
                <div style={{ fontSize: 12, color: RAMS_INK_QUIET, lineHeight: 1.5 }}>
                  {nativeKeychain
                    ? 'This editor manages the native Keychain value. A matching environment variable takes precedence when present.'
                    : 'Open o8 Desktop on macOS to manage this native Keychain value.'}
                </div>
                <a href={key.docsUrl} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-flex', alignItems: 'center', minHeight: 32, width: 'fit-content', fontSize: 12, color: 'var(--t-text-muted)', textDecoration: 'underline', textDecorationColor: RAMS_HAIRLINE_SOFT, textUnderlineOffset: 3 }}>get key ›</a>
              </div>
              {nativeKeychain && bridgeAvailable && !editing ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
                  <button type="button" onClick={() => { setRemovingKey(null); setEditingKey(key.id); setKeyInput(''); }} style={accentLinkStyle(false)}>{configured ? 'update key' : 'add key'}</button>
                  {configured ? <RamsButton variant="danger" disabled={busy} onClick={() => setRemovingKey(key.id)}>Remove</RamsButton> : null}
                </div>
              ) : null}
            </div>
            {removingKey === key.id ? <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <p style={{ margin: 0, fontSize: 13, color: 'var(--t-text-secondary)' }}>Remove the saved {key.label} key from this Mac? You will need to add it again to use this connection.</p>
              <div style={{ display: 'flex', gap: 8 }}>
                <RamsButton variant="danger" busy={busy} onClick={() => void removeKey(key)}>Confirm removal</RamsButton>
                <RamsButton variant="ghost" disabled={busy} onClick={() => setRemovingKey(null)}>Cancel</RamsButton>
              </div>
            </div> : null}
            {editing ? (
              <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${RAMS_HAIRLINE_SOFT}`, display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 620 }}>
                <FieldLabel>paste {key.label.toLowerCase()} key</FieldLabel>
                <input
                  type="password"
                  value={keyInput}
                  onChange={(event) => setKeyInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void saveKey(key);
                    if (event.key === 'Escape') setEditingKey(null);
                  }}
                  placeholder={key.placeholder}
                  autoFocus
                  style={{ fontFamily: MONO_FONT_STACK, fontSize: 13, fontWeight: 400, letterSpacing: '0.02em', color: 'var(--t-text)', background: 'transparent', border: 'none', borderBottom: `1px solid ${RAMS_HAIRLINE_SOFT}`, paddingTop: 6, paddingBottom: 8, paddingLeft: 0, paddingRight: 0, outline: 'none', width: '100%' }}
                />
                <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'center' }}>
                  <button type="button" onClick={() => { void saveKey(key); }} disabled={!keyInput.trim() || busy} style={accentLinkStyle(!keyInput.trim() || busy)}>{busy ? 'saving...' : 'save key'}</button>
                  <button type="button" onClick={() => { setEditingKey(null); setKeyInput(''); }} style={quietLinkStyle(false)}>cancel</button>
                </div>
              </div>
            ) : null}
            {rowFeedback ? <div role="status" style={{ marginTop: 10, fontSize: 12, color: rowFeedback.type === 'success' ? '#15803d' : '#dc2626' }}>{rowFeedback.message}</div> : null}
          </div>
        );
      })}
    </div>
  );
}

// ── API Keys Tab ──

export function APIKeysTab() {
  return (
    <div style={{
      paddingTop: 8,
      paddingLeft: 8,
      paddingRight: 8,
      paddingBottom: 40,
      maxWidth: SETTINGS_CONTENT_MAX_WIDTH,
      fontFamily: APP_FONT_STACK,
    }}>
      <TabHeading
        title="API keys"
        subtitle="Manage keys for AI providers. API usage is billed by the provider; signing into a CLI account is managed separately."
      />

      {/* 01 — PROVIDERS */}
      <section style={{ marginBottom: 32 }}>
        <GroupHeader>Provider keys</GroupHeader>
        <ApiKeysProviderList />
      </section>

      <section style={{ marginBottom: 32 }}>
        <GroupHeader>Symon &amp; voice keys</GroupHeader>
        <NativeKeysList />
      </section>

      {/* 02 — STORAGE */}
      <section>
        <GroupHeader>Key storage</GroupHeader>
        <div style={{
          fontSize: 13,
          color: 'var(--t-text-secondary)',
          lineHeight: 1.55,
          maxWidth: 620,
        }}>
          App-service keys stay encrypted in this installation’s local configuration. Native Symon and voice keys stay in macOS Keychain. Existing environment variables remain separate and take precedence where the native resolver supports them.
        </div>
        <div style={{ marginTop: 16 }}>
          <HairlineRule />
        </div>
      </section>
    </div>
  );
}

// ── Support primitives ──

function accentLinkStyle(disabled: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    minHeight: 32,
    paddingLeft: 14,
    paddingRight: 14,
    borderRadius: 9,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: disabled ? RAMS_HAIRLINE_SOFT : 'var(--t-settings-accent-active-border, rgba(29, 78, 216, 0.32))',
    background: disabled ? 'transparent' : 'var(--t-settings-accent-active-bg, rgba(29, 78, 216, 0.1))',
    color: disabled ? RAMS_INK_QUIET : RAMS_ACCENT,
    fontFamily: APP_FONT_STACK,
    fontSize: 12,
    fontWeight: 400,
    letterSpacing: '-0.01em',
    textTransform: 'capitalize' as const,
    cursor: disabled ? 'default' : 'pointer',
    transition: 'background 150ms cubic-bezier(0.22, 1, 0.36, 1), border-color 150ms cubic-bezier(0.22, 1, 0.36, 1)',
    opacity: disabled ? 0.6 : 1,
  };
}

function quietLinkStyle(disabled: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    minHeight: 32,
    fontFamily: APP_FONT_STACK,
    fontSize: 13,
    fontWeight: 400,
    color: 'var(--t-text-muted)',
    background: 'transparent',
    border: 'none',
    borderBottom: `1px solid ${RAMS_HAIRLINE_SOFT}`,
    paddingTop: 2,
    paddingBottom: 2,
    paddingLeft: 0,
    paddingRight: 0,
    cursor: disabled ? 'default' : 'pointer',
    letterSpacing: '-0.005em',
    opacity: disabled ? 0.6 : 1,
  };
}
