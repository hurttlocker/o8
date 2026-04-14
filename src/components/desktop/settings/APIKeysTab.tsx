'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  APP_FONT_STACK,
  CheckCircleIcon,
  KeyIcon,
  LockIcon,
  THEME_ACCENT,
  THEME_ACCENT_BORDER,
  THEME_ACCENT_RING,
  THEME_ACCENT_SOFT,
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

const SUCCESS_BG = 'rgba(52, 199, 89, 0.12)';
const SUCCESS_BORDER = 'rgba(52, 199, 89, 0.18)';
const SUCCESS_TEXT = '#16a34a';
const DANGER_BG = 'rgba(239, 68, 68, 0.05)';
const DANGER_BORDER = 'rgba(239, 68, 68, 0.16)';
const DANGER_TEXT = '#dc2626';

// ── API Keys Tab ──

export function APIKeysTab() {
  const [providers, setProviders] = useState<ProviderKeyInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ provider: string; type: 'success' | 'error'; message: string } | null>(null);

  const loadKeys = useCallback(async () => {
    try {
      const res = await fetch('/api/v2/keys');
      if (res.ok) {
        const data = await res.json();
        setProviders(data.providers);
      }
    } catch { /* ignore */ }
    setLoading(false);
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
        setFeedback({ provider: providerId, type: 'success', message: 'Key saved — active immediately' });
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
        setFeedback({ provider: providerId, type: 'success', message: 'Key removed' });
        void loadKeys();
      }
    } catch { /* ignore */ }
    setSaving(false);
    setTimeout(() => setFeedback(null), 4000);
  }, [loadKeys]);

  if (loading) {
    return (
      <div style={{
        paddingTop: 32,
        paddingLeft: 32,
        paddingRight: 32,
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
      paddingTop: 32,
      paddingLeft: 32,
      paddingRight: 32,
      paddingBottom: 32,
      maxWidth: 780,
      fontFamily: APP_FONT_STACK,
    }}>
      <div style={{
        fontSize: 28,
        fontWeight: 800,
        color: 'var(--t-text)',
        marginBottom: 6,
        letterSpacing: '-0.05em',
        lineHeight: 1,
      }}>
        API Keys
      </div>
      <div style={{
        fontSize: 14,
        color: 'var(--t-text-secondary)',
        marginBottom: 22,
        lineHeight: 1.5,
        maxWidth: 700,
      }}>
        Add your API keys to use models in the Chat panel. Keys are stored locally and never leave your machine.
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {providers.map((p) => {
          const isEditing = editingProvider === p.id;
          const fb = feedback?.provider === p.id ? feedback : null;

          return (
            <div
              key={p.id}
              style={{
                border: '1px solid var(--t-panel-border)',
                borderRadius: 18,
                paddingTop: 16,
                paddingBottom: 16,
                paddingLeft: 18,
                paddingRight: 18,
                background: 'var(--t-panel)',
                transition: 'border-color 180ms ease, transform 180ms ease',
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
              }}
            >
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 14,
                flexWrap: 'wrap',
              }}>
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 14,
                  minWidth: 0,
                  flex: '1 1 420px',
                }}>
                  <div style={{
                    width: 44,
                    height: 44,
                    borderRadius: 14,
                    background: p.configured ? SUCCESS_BG : 'var(--t-bg-card)',
                    border: p.configured ? `1px solid ${SUCCESS_BORDER}` : '1px solid var(--t-panel-border)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                    color: p.configured ? SUCCESS_TEXT : 'var(--t-text-muted)',
                  }}>
                    {p.configured ? <CheckCircleIcon /> : <KeyIcon />}
                  </div>

                  <div style={{
                    flex: 1,
                    minWidth: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 5,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      <div style={{
                        fontSize: 17,
                        fontWeight: 700,
                        color: 'var(--t-text)',
                        letterSpacing: '-0.04em',
                        lineHeight: 1.05,
                      }}>
                        {p.label}
                      </div>
                      <span style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        paddingTop: 4,
                        paddingBottom: 4,
                        paddingLeft: 10,
                        paddingRight: 10,
                        borderRadius: 999,
                        background: p.configured ? SUCCESS_BG : THEME_ACCENT_SOFT,
                        color: p.configured ? SUCCESS_TEXT : THEME_ACCENT,
                        fontSize: 9,
                        fontWeight: 700,
                        letterSpacing: '0.04em',
                      }}>
                        {p.configured ? 'ACTIVE LOCALLY' : 'ADD KEY'}
                      </span>
                      <span style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        paddingTop: 4,
                        paddingBottom: 4,
                        paddingLeft: 10,
                        paddingRight: 10,
                        borderRadius: 999,
                        background: 'var(--t-bg-card)',
                        border: '1px solid var(--t-panel-border)',
                        color: 'var(--t-text-muted)',
                        fontSize: 9,
                        fontWeight: 700,
                        letterSpacing: '0.04em',
                      }}>
                        {p.envVar}
                      </span>
                    </div>

                    <div style={{
                      fontSize: 13,
                      color: 'var(--t-text-secondary)',
                      lineHeight: 1.45,
                      maxWidth: 500,
                    }}>
                      {p.configured
                        ? 'Ready for Chat immediately. Stored only on this machine.'
                        : 'Add a provider key to unlock this model family in Chat. Keys stay local to this installation.'}
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      {p.configured && p.maskedKey ? (
                        <span style={{
                          fontSize: 14,
                          fontWeight: 600,
                          color: 'var(--t-text)',
                          letterSpacing: '-0.02em',
                          fontVariantNumeric: 'tabular-nums',
                        }}>
                          {p.maskedKey}
                        </span>
                      ) : (
                        <span style={{ fontSize: 13, color: 'var(--t-text-muted)' }}>
                          Not configured yet
                        </span>
                      )}
                      <a
                        href={p.docsUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 4,
                          color: 'var(--t-text-muted)',
                          fontSize: 11,
                          fontWeight: 600,
                          textDecoration: 'none',
                        }}
                      >
                        Get key ↗
                      </a>
                    </div>
                  </div>
                </div>

                {!isEditing && (
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    flexWrap: 'wrap',
                    marginLeft: 'auto',
                  }}>
                    <button
                      type="button"
                      onClick={() => { setEditingProvider(p.id); setKeyInput(''); }}
                      style={{
                        minHeight: 36,
                        paddingTop: 0,
                        paddingBottom: 0,
                        paddingLeft: 14,
                        paddingRight: 14,
                        border: p.configured ? `1px solid ${THEME_ACCENT_BORDER}` : `1px solid ${THEME_ACCENT}`,
                        borderRadius: 999,
                        background: p.configured ? 'transparent' : THEME_ACCENT,
                        color: p.configured ? THEME_ACCENT : '#ffffff',
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: 'pointer',
                        boxShadow: 'none',
                        transition: 'background 180ms ease, border-color 180ms ease',
                      }}
                    >
                      {p.configured ? 'Update key' : 'Add key'}
                    </button>
                    {p.configured && (
                      <button
                        type="button"
                        onClick={() => { void handleRemove(p.id); }}
                        disabled={saving}
                        style={{
                          minHeight: 36,
                          paddingTop: 0,
                          paddingBottom: 0,
                          paddingLeft: 14,
                          paddingRight: 14,
                          border: `1px solid ${DANGER_BORDER}`,
                          borderRadius: 999,
                          background: 'transparent',
                          color: DANGER_TEXT,
                          fontSize: 12,
                          fontWeight: 600,
                          cursor: saving ? 'default' : 'pointer',
                          opacity: saving ? 0.6 : 1,
                          transition: 'opacity 180ms ease',
                        }}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* Editing input */}
              {isEditing && (
                <div style={{
                  borderTop: '1px solid var(--t-divider)',
                  paddingTop: 14,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                }}>
                  <div style={{
                    fontSize: 11,
                    fontWeight: 700,
                    color: 'var(--t-text-muted)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                  }}>
                    Paste {p.label} API key
                  </div>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <input
                      type="password"
                      value={keyInput}
                      onChange={(e) => setKeyInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') void handleSave(p.id); if (e.key === 'Escape') setEditingProvider(null); }}
                      placeholder={p.placeholder}
                      autoFocus
                      style={{
                        flex: '1 1 340px',
                        minHeight: 40,
                        paddingTop: 0,
                        paddingBottom: 0,
                        paddingLeft: 14,
                        paddingRight: 14,
                        border: '1px solid var(--t-input-border)',
                        borderRadius: 12,
                        background: 'var(--t-input-bg)',
                        fontSize: 13,
                        fontFamily: APP_FONT_STACK,
                        color: 'var(--t-text)',
                        outline: 'none',
                      }}
                      onFocus={(e) => {
                        e.currentTarget.style.borderColor = THEME_ACCENT;
                        e.currentTarget.style.boxShadow = `0 0 0 3px ${THEME_ACCENT_RING}`;
                      }}
                      onBlur={(e) => {
                        e.currentTarget.style.borderColor = 'var(--t-input-border)';
                        e.currentTarget.style.boxShadow = 'none';
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => { void handleSave(p.id); }}
                      disabled={!keyInput.trim() || saving}
                      style={{
                        minHeight: 38,
                        paddingTop: 0,
                        paddingBottom: 0,
                        paddingLeft: 14,
                        paddingRight: 14,
                        border: '1px solid transparent',
                        borderRadius: 999,
                        background: keyInput.trim() ? THEME_ACCENT : 'var(--t-bg-card)',
                        color: keyInput.trim() ? '#ffffff' : 'var(--t-text-faint)',
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: keyInput.trim() && !saving ? 'pointer' : 'default',
                        boxShadow: keyInput.trim() ? `0 10px 24px ${THEME_ACCENT_RING}` : 'none',
                        transition: 'background 180ms ease, box-shadow 180ms ease, opacity 180ms ease',
                        opacity: saving ? 0.7 : 1,
                      }}
                    >
                      {saving ? 'Saving…' : 'Save key'}
                    </button>
                    <button
                      type="button"
                      onClick={() => { setEditingProvider(null); setKeyInput(''); }}
                      style={{
                        minHeight: 38,
                        paddingTop: 0,
                        paddingBottom: 0,
                        paddingLeft: 14,
                        paddingRight: 14,
                        border: '1px solid var(--t-panel-border)',
                        borderRadius: 999,
                        background: 'transparent',
                        color: 'var(--t-text-muted)',
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                  <div style={{
                    fontSize: 11,
                    color: 'var(--t-text-muted)',
                    lineHeight: 1.5,
                  }}>
                    The new key is written to{' '}
                    <span style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      paddingTop: 2,
                      paddingBottom: 2,
                      paddingLeft: 8,
                      paddingRight: 8,
                      borderRadius: 999,
                      background: 'var(--t-bg-card)',
                      border: '1px solid var(--t-panel-border)',
                      color: 'var(--t-text-secondary)',
                      fontSize: 10,
                      fontWeight: 700,
                      letterSpacing: '0.02em',
                    }}
                    >
                      .env.local
                    </span>{' '}
                    and becomes available right away.
                  </div>
                </div>
              )}

              {/* Feedback */}
              {fb && (
                <div style={{
                  paddingTop: 8,
                  paddingBottom: 8,
                  paddingLeft: 12,
                  paddingRight: 12,
                  borderRadius: 12,
                  background: fb.type === 'success' ? SUCCESS_BG : DANGER_BG,
                  border: fb.type === 'success' ? `1px solid ${SUCCESS_BORDER}` : `1px solid ${DANGER_BORDER}`,
                  color: fb.type === 'success' ? SUCCESS_TEXT : DANGER_TEXT,
                  fontSize: 11,
                  fontWeight: 600,
                }}>
                  {fb.message}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div style={{
        marginTop: 24,
        paddingTop: 16,
        paddingBottom: 16,
        paddingLeft: 18,
        paddingRight: 18,
        borderRadius: 16,
        border: '1px solid var(--t-panel-border)',
        background: 'var(--t-panel)',
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        maxWidth: 760,
      }}>
        <div style={{
          width: 28,
          height: 28,
          borderRadius: 10,
          background: THEME_ACCENT_SOFT,
          color: THEME_ACCENT,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}>
          <LockIcon />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{
            fontSize: 11,
            fontWeight: 700,
            color: 'var(--t-text-muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
          }}>
            Local storage
          </div>
          <div style={{
            fontSize: 13,
            color: 'var(--t-text-secondary)',
            lineHeight: 1.55,
          }}>
            Keys are written to{' '}
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              paddingTop: 2,
              paddingBottom: 2,
              paddingLeft: 8,
              paddingRight: 8,
              borderRadius: 999,
              background: 'var(--t-bg-card)',
              border: '1px solid var(--t-panel-border)',
              color: 'var(--t-text-secondary)',
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.02em',
            }}
            >
              .env.local
            </span>{' '}
            and take effect immediately. In the cloud version, keys are encrypted and stored in your account.
          </div>
        </div>
      </div>
    </div>
  );
}
