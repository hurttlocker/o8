'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  APP_FONT_STACK,
  MONO_FONT_STACK,
  RAMS_ACCENT,
  RAMS_HAIRLINE_SOFT,
  RAMS_INK_QUIET,
  BracketLabel,
  FieldLabel,
  HairlineRule,
  SectionLabel,
  TabHeading,
  SETTINGS_CONTENT_MAX_WIDTH,
} from './shared';

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

// ── Provider list (reusable) ──
// Extracted so the Models tab can inline the BYOK provider surface without the
// NEXT_PUBLIC_O8_SHOW_BYOK env flag (#1450 wave 2). Owns its own fetch + editor
// state; both APIKeysTab and ModelsTab render it against the live /api/v2/keys
// backend.

export function ApiKeysProviderList() {
  const [providers, setProviders] = useState<ProviderKeyInfo[]>([]);
  const [loading, setLoading] = useState(true);
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
    try {
      const res = await fetch('/api/v2/keys');
      if (res.ok) {
        const data = await res.json();
        if (mountedRef.current) setProviders(data.providers);
      }
    } catch { /* ignore */ }
    if (mountedRef.current) setLoading(false);
  }, []);

  useEffect(() => {
    let active = true;

    void (async () => {
      try {
        const res = await fetch('/api/v2/keys');
        if (!active) return;
        if (res.ok) {
          const data = await res.json();
          if (active) setProviders(data.providers);
        }
      } catch {
        // ignore
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, []);

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
                    {p.label}
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
                    ? 'Available to the orchestrator and assistant. Stored on this machine only.'
                    : 'Add a key to unlock this model family. Stays local to this installation.'}
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

// ── API Keys Tab ──

export function APIKeysTab() {
  return (
    <div style={{
      paddingTop: 8,
      paddingLeft: 8,
      paddingRight: 32,
      paddingBottom: 40,
      maxWidth: SETTINGS_CONTENT_MAX_WIDTH,
      fontFamily: APP_FONT_STACK,
    }}>
      <TabHeading
        title="API keys"
        subtitle="Provider keys unlock model families in the orchestrator and assistant. Keys stay local to this installation and take effect immediately."
      />

      {/* 01 — PROVIDERS */}
      <section style={{ marginBottom: 32 }}>
        <SectionLabel number="01">PROVIDERS</SectionLabel>
        <ApiKeysProviderList />
      </section>

      {/* Adaptive-thinking toggle moved to Dispatch → Founders → Model tiers
          (#1450 IA pass) — it was unreachable here behind the BYOK env gate. */}

      {/* 02 — STORAGE */}
      <section>
        <SectionLabel number="02">STORAGE</SectionLabel>
        <div style={{
          fontSize: 13,
          color: 'var(--t-text-secondary)',
          lineHeight: 1.55,
          maxWidth: 620,
        }}>
          Keys are AES-256-GCM encrypted and written to{' '}
          <span style={{
            fontFamily: MONO_FONT_STACK,
            fontSize: 12,
            letterSpacing: '0.04em',
            color: 'var(--t-text-secondary)',
          }}>
            ~/.o8/.env.local
          </span>
          {' '}and take effect immediately. They never leave this machine. Beta feature — removed before official release in favour of the hosted plan.
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
