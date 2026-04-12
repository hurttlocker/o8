'use client';

import { useState, useEffect, useCallback } from 'react';
import { CheckCircleIcon, KeyIcon } from './shared';

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
      <div style={{ paddingTop: 32, paddingLeft: 32, paddingRight: 32, color: '#94a3b8', fontSize: 13 }}>
        Loading API keys...
      </div>
    );
  }

  return (
    <div style={{ paddingTop: 32, paddingLeft: 32, paddingRight: 32, paddingBottom: 32, maxWidth: 640 }}>
      <div style={{ fontSize: 20, fontWeight: 600, color: '#0f172a', marginBottom: 4 }}>
        API Keys
      </div>
      <div style={{ fontSize: 13, color: '#94a3b8', marginBottom: 24, lineHeight: '1.5' }}>
        Add your API keys to use models in the Chat panel. Keys are stored locally and never leave your machine.
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {providers.map((p) => {
          const isEditing = editingProvider === p.id;
          const fb = feedback?.provider === p.id ? feedback : null;

          return (
            <div
              key={p.id}
              style={{
                border: '1px solid #e2e8f0',
                borderRadius: 12,
                paddingTop: 16,
                paddingBottom: 16,
                paddingLeft: 20,
                paddingRight: 20,
                background: '#fafafa',
                transition: 'border-color 150ms',
              }}
            >
              {/* Header row */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: isEditing ? 12 : 0 }}>
                <div style={{
                  width: 32,
                  height: 32,
                  borderRadius: 8,
                  background: p.configured ? '#ecfdf5' : '#f8fafc',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}>
                  {p.configured ? (
                    <CheckCircleIcon />
                  ) : (
                    <KeyIcon />
                  )}
                </div>

                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 500, color: '#0f172a' }}>{p.label}</div>
                  {p.configured && p.maskedKey && !isEditing && (
                    <div style={{ fontSize: 12, color: '#94a3b8', fontFamily: 'ui-monospace, monospace', marginTop: 2 }}>
                      {p.maskedKey}
                    </div>
                  )}
                  {!p.configured && !isEditing && (
                    <div style={{ fontSize: 12, color: '#cbd5e1', marginTop: 2 }}>Not configured</div>
                  )}
                </div>

                {/* Action buttons */}
                {!isEditing && (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      type="button"
                      onClick={() => { setEditingProvider(p.id); setKeyInput(''); }}
                      style={{
                        paddingTop: 6,
                        paddingBottom: 6,
                        paddingLeft: 12,
                        paddingRight: 12,
                        border: '1px solid #e2e8f0',
                        borderRadius: 8,
                        background: 'white',
                        color: '#3b82f6',
                        fontSize: 12,
                        fontWeight: 500,
                        cursor: 'pointer',
                        fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
                        transition: 'background 100ms',
                      }}
                      onMouseEnter={(e) => { (e.currentTarget).style.background = '#f8fafc'; }}
                      onMouseLeave={(e) => { (e.currentTarget).style.background = 'white'; }}
                    >
                      {p.configured ? 'Update' : 'Add Key'}
                    </button>
                    {p.configured && (
                      <button
                        type="button"
                        onClick={() => { void handleRemove(p.id); }}
                        disabled={saving}
                        style={{
                          paddingTop: 6,
                          paddingBottom: 6,
                          paddingLeft: 12,
                          paddingRight: 12,
                          border: '1px solid #fecaca',
                          borderRadius: 8,
                          background: 'white',
                          color: '#ef4444',
                          fontSize: 12,
                          fontWeight: 500,
                          cursor: 'pointer',
                          fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
                          transition: 'background 100ms',
                        }}
                        onMouseEnter={(e) => { (e.currentTarget).style.background = '#fef2f2'; }}
                        onMouseLeave={(e) => { (e.currentTarget).style.background = 'white'; }}
                      >
                        Remove
                      </button>
                    )}
                    <a
                      href={p.docsUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        paddingTop: 6,
                        paddingBottom: 6,
                        paddingLeft: 10,
                        paddingRight: 10,
                        border: '1px solid #e2e8f0',
                        borderRadius: 8,
                        background: 'white',
                        color: '#94a3b8',
                        fontSize: 12,
                        textDecoration: 'none',
                        cursor: 'pointer',
                        transition: 'background 100ms',
                      }}
                      onMouseEnter={(e) => { (e.currentTarget).style.background = '#f8fafc'; }}
                      onMouseLeave={(e) => { (e.currentTarget).style.background = 'white'; }}
                    >
                      Get key ↗
                    </a>
                  </div>
                )}
              </div>

              {/* Editing input */}
              {isEditing && (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input
                    type="password"
                    value={keyInput}
                    onChange={(e) => setKeyInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void handleSave(p.id); if (e.key === 'Escape') setEditingProvider(null); }}
                    placeholder={p.placeholder}
                    autoFocus
                    style={{
                      flex: 1,
                      paddingTop: 8,
                      paddingBottom: 8,
                      paddingLeft: 12,
                      paddingRight: 12,
                      border: '1px solid #cbd5e1',
                      borderRadius: 8,
                      background: 'white',
                      fontSize: 13,
                      fontFamily: 'ui-monospace, monospace',
                      color: '#0f172a',
                      outline: 'none',
                    }}
                    onFocus={(e) => { (e.currentTarget).style.borderColor = '#3b82f6'; (e.currentTarget).style.boxShadow = '0 0 0 3px rgba(59,130,246,0.1)'; }}
                    onBlur={(e) => { (e.currentTarget).style.borderColor = '#cbd5e1'; (e.currentTarget).style.boxShadow = 'none'; }}
                  />
                  <button
                    type="button"
                    onClick={() => { void handleSave(p.id); }}
                    disabled={!keyInput.trim() || saving}
                    style={{
                      paddingTop: 8,
                      paddingBottom: 8,
                      paddingLeft: 16,
                      paddingRight: 16,
                      border: 'none',
                      borderRadius: 8,
                      background: keyInput.trim() ? '#3b82f6' : '#e2e8f0',
                      color: keyInput.trim() ? 'white' : '#94a3b8',
                      fontSize: 13,
                      fontWeight: 500,
                      cursor: keyInput.trim() ? 'pointer' : 'default',
                      fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
                      transition: 'background 150ms',
                    }}
                  >
                    {saving ? 'Saving...' : 'Save'}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setEditingProvider(null); setKeyInput(''); }}
                    style={{
                      paddingTop: 8,
                      paddingBottom: 8,
                      paddingLeft: 12,
                      paddingRight: 12,
                      border: '1px solid #e2e8f0',
                      borderRadius: 8,
                      background: 'white',
                      color: '#64748b',
                      fontSize: 13,
                      cursor: 'pointer',
                      fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
                    }}
                  >
                    Cancel
                  </button>
                </div>
              )}

              {/* Feedback */}
              {fb && (
                <div style={{
                  marginTop: 8,
                  paddingTop: 6,
                  paddingBottom: 6,
                  paddingLeft: 10,
                  paddingRight: 10,
                  borderRadius: 6,
                  background: fb.type === 'success' ? '#ecfdf5' : '#fef2f2',
                  color: fb.type === 'success' ? '#059669' : '#dc2626',
                  fontSize: 12,
                  fontWeight: 500,
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
        borderTop: '1px solid #f1f5f9',
        fontSize: 12,
        color: '#cbd5e1',
        lineHeight: '1.5',
      }}>
        Keys are written to <code style={{ background: '#f8fafc', paddingTop: 2, paddingBottom: 2, paddingLeft: 4, paddingRight: 4, borderRadius: 4, fontSize: 11 }}>.env.local</code> and take effect immediately — no restart needed.
        In the cloud version, keys will be encrypted and stored in your account.
      </div>
    </div>
  );
}
