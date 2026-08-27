'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';

import { createSavedPrompt, derivePromptTitle, type PromptLibraryScope } from '@/lib/prompt-library/client';

const UI_FONT = 'var(--font-sans-system)';

export function SavePromptDialog({ body, repoPath, repoName, onClose }: {
  body: string;
  repoPath: string | null;
  repoName: string;
  onClose: () => void;
}) {
  const [mounted, setMounted] = useState(false);
  const [title, setTitle] = useState(() => derivePromptTitle(body));
  const [tags, setTags] = useState('');
  const [scope, setScope] = useState<PromptLibraryScope>(repoPath ? 'repo' : 'global');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setMounted(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  if (!mounted || typeof document === 'undefined') return null;
  const canSave = Boolean(title.trim() && body.trim() && (scope !== 'repo' || repoPath));

  return createPortal(
    <div role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }} style={overlayStyle}>
      <div role="dialog" aria-label="Save prompt" style={dialogStyle}>
        <div style={{ fontSize: 13.5, fontWeight: 400, color: 'var(--t-text)' }}>Save prompt</div>
        <div style={{ fontSize: 11, fontWeight: 300, lineHeight: 1.45, color: 'var(--t-text-muted)' }}>Keep this brief in your searchable library. It will not send or run anything.</div>
        <Label text="Title" />
        <input autoFocus value={title} onChange={(event) => setTitle(event.currentTarget.value)} style={fieldStyle} />
        <Label text="Tags" hint="optional, comma separated" />
        <input value={tags} onChange={(event) => setTags(event.currentTarget.value)} placeholder="security, review, release" style={fieldStyle} />
        <Label text="Scope" />
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <ScopeButton label="Global" active={scope === 'global'} onClick={() => setScope('global')} />
          <ScopeButton label={repoPath ? repoName : 'Repo unavailable'} active={scope === 'repo'} disabled={!repoPath} onClick={() => setScope('repo')} />
        </div>
        <div style={{ maxHeight: 120, overflowY: 'auto', paddingTop: 9, paddingBottom: 9, paddingLeft: 10, paddingRight: 10, borderRadius: 8, background: 'var(--t-input-bg)', color: 'var(--t-text-secondary)', fontSize: 11, fontWeight: 300, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{body}</div>
        {result ? <div role="status" style={statusStyle}>{result}</div> : null}
        {error ? <div role="alert" style={{ ...statusStyle, color: 'var(--t-danger, #ef4444)' }}>{error}</div> : null}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 4 }}>
          <DialogButton label={result ? 'Done' : 'Cancel'} onClick={onClose} disabled={busy} />
          {!result ? (
            <DialogButton
              label={busy ? 'Saving…' : 'Save prompt'}
              primary
              disabled={!canSave || busy}
              onClick={() => {
                if (!canSave || busy) return;
                setBusy(true);
                setError(null);
                void createSavedPrompt({
                  title,
                  body,
                  tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean),
                  scope,
                  repoPath: scope === 'repo' ? repoPath : null,
                }).then((saved) => {
                  setResult(saved.created ? 'Prompt saved.' : 'This prompt is already saved in that scope.');
                }).catch((cause) => {
                  setError(cause instanceof Error ? cause.message : 'The prompt could not be saved.');
                }).finally(() => setBusy(false));
              }}
            />
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Label({ text, hint }: { text: string; hint?: string }) {
  return <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}><span style={{ fontSize: 10, fontWeight: 300, color: 'var(--t-text-faint)' }}>{text}</span>{hint ? <span style={{ fontSize: 9.5, fontWeight: 260, color: 'var(--t-text-faint)' }}>{hint}</span> : null}</div>;
}

function ScopeButton({ label, active, disabled = false, onClick }: { label: string; active: boolean; disabled?: boolean; onClick: () => void }) {
  return <button type="button" disabled={disabled} onClick={onClick} style={{ minHeight: 44, paddingTop: 0, paddingBottom: 0, paddingLeft: 11, paddingRight: 11, border: 'none', borderRadius: 7, background: active ? 'var(--t-input-bg)' : 'transparent', color: active ? 'var(--t-text)' : 'var(--t-text-muted)', fontSize: 12, fontWeight: 300, fontFamily: UI_FONT, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1 }}>{label}</button>;
}

function DialogButton({ label, primary = false, disabled = false, onClick }: { label: string; primary?: boolean; disabled?: boolean; onClick: () => void }) {
  return <button type="button" disabled={disabled} onClick={onClick} style={{ minHeight: 44, paddingTop: 0, paddingBottom: 0, paddingLeft: 12, paddingRight: 12, border: 'none', borderRadius: 7, background: primary ? 'var(--t-accent)' : 'transparent', color: primary ? 'var(--t-accent-contrast, #fff)' : 'var(--t-text-muted)', fontSize: 12, fontWeight: 300, fontFamily: UI_FONT, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1 }}>{label}</button>;
}

const overlayStyle: CSSProperties = { position: 'fixed', top: 0, right: 0, bottom: 0, left: 0, zIndex: 10002, display: 'flex', alignItems: 'center', justifyContent: 'center', paddingTop: 24, paddingBottom: 24, paddingLeft: 24, paddingRight: 24, background: 'rgba(0, 0, 0, 0.5)' };
const dialogStyle: CSSProperties = { width: 460, maxWidth: '100%', display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 20, paddingBottom: 16, paddingLeft: 20, paddingRight: 20, borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--t-divider-subtle)', borderRadius: 16, background: 'var(--t-panel-solid, var(--t-bg-card))', boxShadow: 'var(--t-panel-shadow)', color: 'var(--t-text)', fontFamily: UI_FONT };
const fieldStyle: CSSProperties = { width: '100%', minHeight: 44, paddingTop: 9, paddingBottom: 9, paddingLeft: 10, paddingRight: 10, boxSizing: 'border-box', borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--t-divider-subtle)', borderRadius: 8, outline: 'none', background: 'var(--t-input-bg)', color: 'var(--t-text)', fontSize: 12.5, fontWeight: 300, fontFamily: UI_FONT };
const statusStyle: CSSProperties = { minHeight: 28, paddingTop: 6, fontSize: 11, fontWeight: 300, color: 'var(--t-text-muted)' };
