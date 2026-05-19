'use client';

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ChevronDown } from '../lucide-shims';

/**
 * ReviewGitActions — the Commit / Push / Open PR cluster on the Review
 * surface header (#1080), modeled on the Codex Review toolbar.
 *   - Commit: a split button — the primary face opens a message composer;
 *     the caret menu offers Commit and Push.
 *   - Open PR: disabled on the repo's default branch; otherwise pushes the
 *     branch and opens GitHub's PR-create form. The new PR then surfaces in
 *     the existing O8 panel "PRs" tab on its next poll.
 */

const UI_FONT = 'var(--font-sans-system)';
const DEFAULT_BRANCHES = new Set(['main', 'master']);

const POPOVER_SURFACE: CSSProperties = {
  position: 'absolute',
  top: 34,
  right: 0,
  borderRadius: 10,
  background: 'var(--t-bg-card)',
  border: '1px solid var(--t-divider)',
  boxShadow: '0 10px 28px rgba(0, 0, 0, 0.22)',
  zIndex: 60,
};

const SPLIT_FACE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  border: 'none',
  background: 'transparent',
  color: 'var(--t-text)',
  fontFamily: UI_FONT,
  fontSize: 12,
  fontWeight: 650,
  cursor: 'pointer',
};

// ── icons (raw SVG — React icon components don't render in the Tauri webview) ──

function IconCommit({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <circle cx="12" cy="12" r="3" />
      <line x1="3" y1="12" x2="9" y2="12" />
      <line x1="15" y1="12" x2="21" y2="12" />
    </svg>
  );
}

function IconPush({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M12 19V8" />
      <path d="m7 12 5-5 5 5" />
      <path d="M5 21h14" />
    </svg>
  );
}

function IconPullRequest({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <circle cx="6" cy="6" r="3" />
      <circle cx="18" cy="18" r="3" />
      <path d="M6 9v6" />
      <path d="M13 6h3a2 2 0 0 1 2 2v7" />
    </svg>
  );
}

// ── menu / composer primitives ──

function GitMenuRow({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        height: 30,
        paddingLeft: 9,
        paddingRight: 9,
        border: 'none',
        borderRadius: 7,
        background: 'transparent',
        color: 'var(--t-text)',
        fontFamily: UI_FONT,
        fontSize: 12,
        cursor: 'pointer',
        textAlign: 'left',
      }}
      onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--t-hover)'; }}
      onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
    >
      <span style={{ display: 'inline-flex', color: 'var(--t-text-muted)' }}>{icon}</span>
      <span style={{ flex: 1, minWidth: 0 }}>{label}</span>
    </button>
  );
}

function ComposerButton({ label, primary, disabled, onClick }: { label: string; primary?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        height: 26,
        paddingLeft: 11,
        paddingRight: 11,
        borderRadius: 7,
        border: primary ? 'none' : '1px solid var(--t-input-border)',
        background: primary ? (disabled ? 'var(--t-divider)' : 'var(--t-accent)') : 'transparent',
        color: primary ? '#ffffff' : 'var(--t-text-muted)',
        fontFamily: UI_FONT,
        fontSize: 11.5,
        fontWeight: 650,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {label}
    </button>
  );
}

// ── component ──

type Toast = { tone: 'ok' | 'err'; text: string };

export function ReviewGitActions({
  repoPath,
  branch,
  repoSlug,
  onChanged,
}: {
  repoPath?: string | null;
  branch?: string | null;
  repoSlug?: string | null;
  onChanged: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [commitOpen, setCommitOpen] = useState(false);
  const [commitMsg, setCommitMsg] = useState('');
  const [commitError, setCommitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const onDefaultBranch = !branch || DEFAULT_BRANCHES.has(branch);

  // Dismiss the menu / composer on outside-click or Escape.
  useEffect(() => {
    if (!menuOpen && !commitOpen) return;
    const dismiss = () => { setMenuOpen(false); setCommitOpen(false); };
    const onPointer = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) dismiss();
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') dismiss(); };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen, commitOpen]);

  // Auto-dismiss the toast.
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 4500);
    return () => window.clearTimeout(id);
  }, [toast]);

  const post = async (path: string, payload: Record<string, unknown>) => {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, workspace: repoPath ?? undefined }),
    });
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : `HTTP ${response.status}`);
    return data;
  };

  const runCommit = async () => {
    const message = commitMsg.trim();
    if (!message || busy) return;
    setBusy(true);
    setCommitError(null);
    try {
      const data = await post('/api/review/commit', { message });
      setToast({ tone: 'ok', text: `Committed ${typeof data.hash === 'string' ? data.hash : ''}`.trim() });
      setCommitMsg('');
      setCommitOpen(false);
      onChanged();
    } catch (error) {
      setCommitError(error instanceof Error ? error.message : 'Commit failed');
    } finally {
      setBusy(false);
    }
  };

  const runPush = async () => {
    if (busy) return;
    setMenuOpen(false);
    setBusy(true);
    try {
      const data = await post('/api/review/push', {});
      setToast({ tone: 'ok', text: typeof data.message === 'string' ? data.message : 'Pushed' });
    } catch (error) {
      setToast({ tone: 'err', text: error instanceof Error ? error.message : 'Push failed' });
    } finally {
      setBusy(false);
    }
  };

  const runOpenPr = async () => {
    if (busy || onDefaultBranch || !branch) return;
    setBusy(true);
    try {
      await post('/api/review/push', {});
      if (repoSlug) {
        window.open(`https://github.com/${repoSlug}/compare/${branch}?expand=1`, '_blank', 'noopener');
        setToast({ tone: 'ok', text: 'Pushed — opening the PR form' });
      } else {
        setToast({ tone: 'ok', text: 'Pushed — open the PR from GitHub' });
      }
    } catch (error) {
      setToast({ tone: 'err', text: error instanceof Error ? error.message : 'Open PR failed' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={rootRef} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
      <div style={{ display: 'inline-flex', alignItems: 'stretch', height: 28, borderRadius: 8, border: '1px solid var(--t-input-border)', overflow: 'hidden' }}>
        <button
          type="button"
          onClick={() => { setCommitOpen((value) => !value); setMenuOpen(false); setCommitError(null); }}
          title="Commit changes"
          style={{ ...SPLIT_FACE, gap: 5, paddingLeft: 9, paddingRight: 9, background: commitOpen ? 'var(--t-input-bg)' : 'transparent' }}
        >
          <IconCommit size={12} />
          Commit
        </button>
        <button
          type="button"
          onClick={() => { setMenuOpen((value) => !value); setCommitOpen(false); }}
          title="More Git actions"
          aria-label="More Git actions"
          style={{ ...SPLIT_FACE, paddingLeft: 5, paddingRight: 5, borderLeft: '1px solid var(--t-input-border)', color: 'var(--t-text-muted)', background: menuOpen ? 'var(--t-input-bg)' : 'transparent' }}
        >
          <ChevronDown size={12} strokeWidth={2} />
        </button>
      </div>

      <button
        type="button"
        disabled={onDefaultBranch || busy}
        title={onDefaultBranch ? 'Checkout a feature branch before creating a PR' : 'Push and open a pull request'}
        onClick={() => { void runOpenPr(); }}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          height: 28,
          paddingLeft: 9,
          paddingRight: 10,
          borderRadius: 8,
          border: '1px solid var(--t-input-border)',
          background: 'transparent',
          color: onDefaultBranch ? 'var(--t-text-faint)' : 'var(--t-text)',
          fontFamily: UI_FONT,
          fontSize: 12,
          fontWeight: 650,
          cursor: onDefaultBranch ? 'not-allowed' : 'pointer',
          opacity: onDefaultBranch ? 0.55 : 1,
        }}
      >
        <IconPullRequest size={12} />
        Open PR
      </button>

      {menuOpen ? (
        <div role="menu" style={{ ...POPOVER_SURFACE, minWidth: 152, paddingTop: 4, paddingBottom: 4, paddingLeft: 4, paddingRight: 4 }}>
          <GitMenuRow icon={<IconCommit size={13} />} label="Commit" onClick={() => { setMenuOpen(false); setCommitOpen(true); setCommitError(null); }} />
          <GitMenuRow icon={<IconPush size={13} />} label={busy ? 'Pushing…' : 'Push'} onClick={() => { void runPush(); }} />
        </div>
      ) : null}

      {commitOpen ? (
        <div style={{ ...POPOVER_SURFACE, width: 300, paddingTop: 10, paddingBottom: 10, paddingLeft: 10, paddingRight: 10 }}>
          <textarea
            value={commitMsg}
            onChange={(event) => { setCommitMsg(event.target.value); setCommitError(null); }}
            placeholder="Commit message…"
            rows={3}
            autoFocus
            spellCheck
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault();
                void runCommit();
              }
            }}
            style={{
              width: '100%',
              resize: 'vertical',
              border: '1px solid var(--t-input-border)',
              borderRadius: 8,
              background: 'var(--t-input-bg)',
              color: 'var(--t-text)',
              fontFamily: UI_FONT,
              fontSize: 12,
              lineHeight: 1.5,
              paddingTop: 7,
              paddingBottom: 7,
              paddingLeft: 9,
              paddingRight: 9,
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
          {commitError ? (
            <div style={{ marginTop: 7, color: 'var(--t-brand-red)', fontFamily: UI_FONT, fontSize: 11 }}>{commitError}</div>
          ) : null}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 9 }}>
            <ComposerButton label="Cancel" onClick={() => { setCommitOpen(false); setCommitError(null); }} />
            <ComposerButton label={busy ? 'Committing…' : 'Commit'} primary disabled={!commitMsg.trim() || busy} onClick={() => { void runCommit(); }} />
          </div>
        </div>
      ) : null}

      {toast ? (
        <div
          style={{
            position: 'absolute',
            top: 34,
            right: 0,
            maxWidth: 320,
            paddingTop: 7,
            paddingBottom: 7,
            paddingLeft: 10,
            paddingRight: 10,
            borderRadius: 8,
            background: 'var(--t-bg-card)',
            border: `1px solid ${toast.tone === 'ok' ? 'var(--t-divider)' : 'var(--t-brand-red)'}`,
            boxShadow: '0 10px 28px rgba(0, 0, 0, 0.22)',
            color: toast.tone === 'ok' ? 'var(--t-text)' : 'var(--t-brand-red)',
            fontFamily: UI_FONT,
            fontSize: 11.5,
            zIndex: 60,
          }}
        >
          {toast.text}
        </div>
      ) : null}
    </div>
  );
}
