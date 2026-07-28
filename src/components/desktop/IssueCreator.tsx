/**
 * IssueCreator — Canvas tab for creating GitHub issues with AI enhancement.
 *
 * Flow: type rough idea → ✨ enhance → review/edit → create
 */

import { memo, useCallback, useState } from 'react';
import { Check, Loader2, Sparkles, Tag, X } from './lucide-shims';
import { MarkdownBody } from './MarkdownBody';

interface IssueCreatorProps {
  repo?: string;
  onCreated?: (issueNumber: number) => void;
}

export const IssueCreator = memo(function IssueCreator({ repo, onCreated }: IssueCreatorProps) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [labels, setLabels] = useState<string[]>([]);
  const [labelInput, setLabelInput] = useState('');
  const [enhancing, setEnhancing] = useState(false);
  const [enhanced, setEnhanced] = useState(false);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ number: number; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);

  const handleEnhance = useCallback(async () => {
    if (!title.trim() && !body.trim()) return;
    setEnhancing(true);
    setError(null);
    try {
      const res = await fetch('/api/panel/issues/enhance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), description: body.trim(), repo }),
      });
      const data = await res.json();
      if (data.error) {
        setError(data.error);
      } else {
        setTitle(data.title || title);
        setBody(data.body || body);
        if (data.labels?.length > 0) {
          setLabels(prev => [...new Set([...prev, ...data.labels])]);
        }
        setEnhanced(true);
      }
    } catch {
      setError('Enhancement failed');
    } finally {
      setEnhancing(false);
    }
  }, [title, body, repo]);

  const handleCreate = useCallback(async () => {
    if (!title.trim()) { setError('Title is required'); return; }
    setCreating(true);
    setError(null);
    try {
      const res = await fetch('/api/panel/issues/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          description: body.trim() || undefined,
          labels: labels.length > 0 ? labels : undefined,
          repo,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setCreated({ number: data.number, url: data.url });
        onCreated?.(data.number);
      } else {
        setError(data.error || 'Failed to create issue');
      }
    } catch {
      setError('Failed to create issue');
    } finally {
      setCreating(false);
    }
  }, [title, body, labels, repo, onCreated]);

  const addLabel = useCallback(() => {
    const l = labelInput.trim().toLowerCase();
    if (l && !labels.includes(l)) {
      setLabels(prev => [...prev, l]);
    }
    setLabelInput('');
  }, [labelInput, labels]);

  // Success state
  if (created) {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        gap: 16,
      }}>
        <div style={{
          width: 56,
          height: 56,
          borderRadius: 28,
          background: 'rgba(34, 197, 94, 0.1)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}>
          <Check size={28} strokeWidth={2.5} style={{ color: '#22c55e' }} />
        </div>
        <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--t-text)' }}>
          Issue #{created.number} created
        </div>
        <div style={{ fontSize: 13, color: 'var(--t-text-secondary)' }}>
          {repo || ''}
        </div>
      </div>
    );
  }

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
    }}>
      {/* Header */}
      <div style={{
        paddingTop: 16,
        paddingRight: 24,
        paddingBottom: 12,
        paddingLeft: 24,
        borderBottom: '1px solid var(--t-divider)',
        background: 'var(--t-panel-translucent)',
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--t-text)' }}>New Issue</div>
          <div style={{ fontSize: 11, color: 'var(--t-text-muted)', marginTop: 2, fontFamily: '"SF Mono", ui-monospace, monospace' }}>
            {repo || ''}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {/* Preview toggle */}
          <button
            type="button"
            onClick={() => setPreview(!preview)}
            style={{
              paddingTop: 6,
              paddingRight: 14,
              paddingBottom: 6,
              paddingLeft: 14,
              borderRadius: 8,
              border: '1px solid var(--t-panel-border)',
              background: preview ? 'rgba(37,99,235,0.06)' : 'var(--t-panel-translucent)',
              fontSize: 12,
              fontWeight: 500,
              color: preview ? '#2563eb' : 'var(--t-text-secondary)',
              cursor: 'pointer',
              fontFamily: 'var(--font-sans-system)',
            }}
          >
            {preview ? 'Edit' : 'Preview'}
          </button>

          {/* Enhance button */}
          <button
            type="button"
            onClick={() => void handleEnhance()}
            disabled={enhancing || (!title.trim() && !body.trim())}
            style={{
              paddingTop: 6,
              paddingRight: 14,
              paddingBottom: 6,
              paddingLeft: 14,
              borderRadius: 8,
              border: 'none',
              background: enhanced ? 'rgba(34,197,94,0.08)' : 'rgba(255,159,10,0.08)',
              fontSize: 12,
              fontWeight: 600,
              color: enhanced ? '#22c55e' : '#ff9f0a',
              cursor: enhancing || (!title.trim() && !body.trim()) ? 'default' : 'pointer',
              opacity: enhancing || (!title.trim() && !body.trim()) ? 0.5 : 1,
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              fontFamily: 'var(--font-sans-system)',
              transition: 'background 150ms cubic-bezier(0.22, 1, 0.36, 1), color 150ms cubic-bezier(0.22, 1, 0.36, 1), opacity 150ms cubic-bezier(0.22, 1, 0.36, 1)',
            }}
          >
            {enhancing ? (
              <Loader2 size={14} className="spin" />
            ) : (
              <Sparkles size={14} strokeWidth={2} />
            )}
            {enhanced ? 'Enhanced' : 'Enhance'}
          </button>

          {/* Create button */}
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={creating || !title.trim()}
            style={{
              paddingTop: 6,
              paddingRight: 18,
              paddingBottom: 6,
              paddingLeft: 18,
              borderRadius: 8,
              border: 'none',
              background: creating || !title.trim() ? '#d1d5db' : '#ef4444',
              fontSize: 12,
              fontWeight: 600,
              color: creating || !title.trim() ? 'var(--t-text-muted)' : '#ffffff',
              cursor: creating || !title.trim() ? 'default' : 'pointer',
              boxShadow: creating || !title.trim() ? 'none' : '0 2px 8px rgba(239,68,68,0.3)',
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              fontFamily: 'var(--font-sans-system)',
              transition: 'background 150ms cubic-bezier(0.22, 1, 0.36, 1), color 150ms cubic-bezier(0.22, 1, 0.36, 1)',
            }}
          >
            {creating ? <Loader2 size={14} className="spin" /> : null}
            Create Issue
          </button>
        </div>
      </div>

      {/* Error banner */}
      {error ? (
        <div style={{
          marginTop: 0,
          paddingTop: 8,
          paddingRight: 24,
          paddingBottom: 8,
          paddingLeft: 24,
          fontSize: 12,
          color: '#ef4444',
          background: 'rgba(239,68,68,0.04)',
          borderBottom: '1px solid rgba(239,68,68,0.08)',
        }}>
          {error}
        </div>
      ) : null}

      {/* Form / Preview */}
      <div style={{ flex: 1, overflowY: 'auto', paddingTop: 20, paddingRight: 24, paddingBottom: 20, paddingLeft: 24 }}>
        {preview ? (
          /* Preview mode */
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 600, color: 'var(--t-text)', marginBottom: 16 }}>
              {title || 'Untitled Issue'}
            </h2>
            {labels.length > 0 ? (
              <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
                {labels.map((l) => (
                  <span key={l} style={{
                    fontSize: 11,
                    fontWeight: 600,
                    paddingTop: 2,
                    paddingRight: 8,
                    paddingBottom: 2,
                    paddingLeft: 8,
                    borderRadius: 99,
                    color: '#3b82f6',
                    background: 'rgba(59,130,246,0.08)',
                  }}>
                    {l}
                  </span>
                ))}
              </div>
            ) : null}
            {body ? (
              <MarkdownBody text={body} />
            ) : (
              <div style={{ fontSize: 13, color: 'var(--t-text-muted)', fontStyle: 'italic' }}>No description</div>
            )}
          </div>
        ) : (
          /* Edit mode */
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Title */}
            <div>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--t-text-secondary)', marginBottom: 6 }}>
                Title
              </label>
              <input
                type="text"
                value={title}
                onChange={(e) => { setTitle(e.target.value); setEnhanced(false); }}
                placeholder="What needs to happen?"
                style={{
                  width: '100%',
                  paddingTop: 10,
                  paddingRight: 14,
                  paddingBottom: 10,
                  paddingLeft: 14,
                  borderRadius: 10,
                  border: '1px solid var(--t-input-border)',
                  background: 'var(--t-input-bg)',
                  backdropFilter: 'blur(12px)',
                  WebkitBackdropFilter: 'blur(12px)',
                  fontSize: 14,
                  fontWeight: 500,
                  color: 'var(--t-text)',
                  outline: 'none',
                  fontFamily: 'var(--font-sans-system)',
                  boxSizing: 'border-box',
                }}
              />
            </div>

            {/* Body */}
            <div style={{ flex: 1 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--t-text-secondary)', marginBottom: 6 }}>
                Description
              </label>
              <textarea
                value={body}
                onChange={(e) => { setBody(e.target.value); setEnhanced(false); }}
                placeholder="Describe the issue, feature, or rough idea… Enhance will structure it for you."
                style={{
                  width: '100%',
                  minHeight: 220,
                  paddingTop: 12,
                  paddingRight: 14,
                  paddingBottom: 12,
                  paddingLeft: 14,
                  borderRadius: 10,
                  border: '1px solid var(--t-input-border)',
                  background: 'var(--t-input-bg)',
                  backdropFilter: 'blur(12px)',
                  WebkitBackdropFilter: 'blur(12px)',
                  fontSize: 13,
                  color: 'var(--t-text)',
                  lineHeight: 1.7,
                  outline: 'none',
                  resize: 'vertical',
                  fontFamily: '"SF Mono", ui-monospace, monospace',
                  boxSizing: 'border-box',
                }}
              />
            </div>

            {/* Labels */}
            <div>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--t-text-secondary)', marginBottom: 6 }}>
                Labels
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                {labels.map((l) => (
                  <span key={l} style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    fontSize: 11,
                    fontWeight: 600,
                    paddingTop: 3,
                    paddingRight: 8,
                    paddingBottom: 3,
                    paddingLeft: 8,
                    borderRadius: 99,
                    color: '#3b82f6',
                    background: 'rgba(59,130,246,0.08)',
                  }}>
                    <Tag size={10} strokeWidth={2} />
                    {l}
                    <button
                      type="button"
                      onClick={() => setLabels(prev => prev.filter(x => x !== l))}
                      style={{
                        display: 'inline-flex',
                        border: 'none',
                        background: 'transparent',
                        padding: 0,
                        cursor: 'pointer',
                        color: 'var(--t-text-muted)',
                        marginLeft: 2,
                      }}
                    >
                      <X size={10} strokeWidth={2.5} />
                    </button>
                  </span>
                ))}
                <input
                  type="text"
                  value={labelInput}
                  onChange={(e) => setLabelInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); addLabel(); }
                    if (e.key === 'Backspace' && !labelInput && labels.length > 0) {
                      setLabels(prev => prev.slice(0, -1));
                    }
                  }}
                  placeholder={labels.length === 0 ? 'Add labels (Enter to add)' : 'Add more…'}
                  style={{
                    flex: 1,
                    minWidth: 120,
                    paddingTop: 6,
                    paddingRight: 10,
                    paddingBottom: 6,
                    paddingLeft: 10,
                    borderRadius: 6,
                    border: '1px solid var(--t-divider)',
                    background: 'transparent',
                    fontSize: 12,
                    color: 'var(--t-text)',
                    outline: 'none',
                    fontFamily: 'var(--font-sans-system)',
                  }}
                />
              </div>
            </div>

            {/* Enhancement hint */}
            {!enhanced && (title.trim() || body.trim()) ? (
              <div style={{
                fontSize: 12,
                color: 'var(--t-text-muted)',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                paddingTop: 4,
              }}>
                <Sparkles size={13} strokeWidth={1.8} style={{ color: '#ff9f0a' }} />
                Tip: Click Enhance to structure your issue with AI — adds sections, acceptance criteria, and label suggestions.
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
});
