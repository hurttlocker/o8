'use client';

/**
 * SessionRulesChip (#1329) — the "Rules · N" chip beside the permission chip in
 * the orchestrator composer. Opens a themed portal popover (ComposerPopover)
 * listing the MERGED rule set governing this thread with tier badges:
 *
 *   Session — operator-authored, thread-scoped, editable here (inline add +
 *             remove). Pinned into every orchestrator turn + inherited by
 *             dispatched workers. Die with the thread.
 *   Repo    — Cortex directives scoped to the active repo (read-only).
 *   Global  — global-scope Cortex directives (read-only).
 *
 * N = total active rules across all tiers. All chrome uses var(--t-*) tokens —
 * the portal-popover-hardcoded-dark trap is exactly what this must not do.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ComposerPopover } from './chat-panel/ComposerPopover';

interface SessionRule {
  id: string;
  threadId: string;
  text: string;
  active: boolean;
  createdAt: string;
}

interface DirectiveRow {
  id: string;
  title: string;
  scope: string;
  repoName?: string;
  body: string;
}

interface SessionRulesChipProps {
  /** Orchestrator thread id — null when the thread hasn't been minted yet. */
  threadId: string | null;
  /** Active repo path — resolves the Repo/Global directive tiers. */
  repoPath?: string | null;
}

function isGlobalScope(scope: string): boolean {
  return scope === 'global' || scope === '';
}

function TierBadge({ label }: { label: string }) {
  return (
    <span style={{
      fontSize: 8.5,
      fontWeight: 300,
      letterSpacing: '0.04em',
      textTransform: 'uppercase' as const,
      color: 'var(--t-text-faint)',
      borderWidth: 1,
      borderStyle: 'solid',
      borderColor: 'var(--t-border)',
      borderRadius: 4,
      paddingTop: 1,
      paddingBottom: 1,
      paddingLeft: 4,
      paddingRight: 4,
      lineHeight: 1.2,
      flexShrink: 0,
    }}>
      {label}
    </span>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <div style={{
      fontSize: 9,
      fontWeight: 300,
      letterSpacing: '0.04em',
      textTransform: 'uppercase' as const,
      color: 'var(--t-text-faint)',
      paddingLeft: 8,
      paddingRight: 8,
      paddingTop: 6,
      paddingBottom: 2,
    }}>
      {children}
    </div>
  );
}

export function SessionRulesChip({ threadId, repoPath }: SessionRulesChipProps) {
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [sessionRules, setSessionRules] = useState<SessionRule[]>([]);
  const [directives, setDirectives] = useState<DirectiveRow[]>([]);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [hovered, setHovered] = useState(false);

  const loadSessionRules = useCallback(async () => {
    if (!threadId) {
      setSessionRules([]);
      return;
    }
    try {
      const res = await fetch(`/api/orchestrator/session-rules?threadId=${encodeURIComponent(threadId)}`);
      const data = await res.json().catch(() => null) as { ok?: boolean; result?: { rules?: SessionRule[] } } | null;
      if (data?.ok && Array.isArray(data.result?.rules)) {
        setSessionRules(data.result.rules);
      }
    } catch (error) {
      console.warn('[session-rules] failed to load session rules', error);
    }
  }, [threadId]);

  const loadDirectives = useCallback(async () => {
    try {
      const query = repoPath ? `?repoPath=${encodeURIComponent(repoPath)}` : '';
      const res = await fetch(`/api/cortex/directives${query}`);
      const data = await res.json().catch(() => null) as { directives?: DirectiveRow[] } | null;
      if (Array.isArray(data?.directives)) {
        setDirectives(data.directives);
      }
    } catch (error) {
      console.warn('[session-rules] failed to load directives', error);
    }
  }, [repoPath]);

  // Refresh both tiers when the thread/repo changes (keeps the chip count
  // honest) and again whenever the popover opens (fresh read on interaction).
  useEffect(() => {
    void loadSessionRules();
    void loadDirectives();
  }, [loadSessionRules, loadDirectives]);
  useEffect(() => {
    if (!open) return;
    void loadSessionRules();
    void loadDirectives();
  }, [open, loadSessionRules, loadDirectives]);

  const handleAdd = useCallback(async () => {
    const text = draft.trim();
    if (!text || !threadId || pending) return;
    setPending(true);
    try {
      const res = await fetch('/api/orchestrator/session-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId, text }),
      });
      const data = await res.json().catch(() => null) as { ok?: boolean } | null;
      if (data?.ok) {
        setDraft('');
        await loadSessionRules();
      } else {
        console.warn('[session-rules] add rejected', data);
      }
    } catch (error) {
      console.warn('[session-rules] add failed', error);
    } finally {
      setPending(false);
    }
  }, [draft, threadId, pending, loadSessionRules]);

  const handleRemove = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/orchestrator/session-rules?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      const data = await res.json().catch(() => null) as { ok?: boolean } | null;
      if (data?.ok) await loadSessionRules();
    } catch (error) {
      console.warn('[session-rules] remove failed', error);
    }
  }, [loadSessionRules]);

  const repoDirectives = directives.filter((d) => !isGlobalScope(d.scope));
  const globalDirectives = directives.filter((d) => isGlobalScope(d.scope));
  const total = sessionRules.length + repoDirectives.length + globalDirectives.length;
  const lit = open || sessionRules.length > 0;

  const ruleRowStyle = {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 6,
    paddingTop: 4,
    paddingBottom: 4,
    paddingLeft: 8,
    paddingRight: 6,
    borderRadius: 6,
  } as const;

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-label={`Session rules (${total} active)`}
        aria-expanded={open}
        title="Rules governing this session — session rules are pinned into every turn and inherited by dispatched agents."
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          height: 24,
          paddingLeft: 6,
          paddingRight: 6,
          borderRadius: 6,
          borderWidth: 0,
          background: lit ? 'var(--t-accent-soft)' : 'transparent',
          color: lit ? 'var(--t-accent)' : hovered ? 'var(--t-text)' : 'var(--t-text-faint)',
          cursor: 'pointer',
          transition: 'color 120ms, background 120ms',
          fontSize: 11,
          fontWeight: 300,
          letterSpacing: '-0.1px',
          fontFamily: 'var(--font-sans-system)',
          flexShrink: 0,
        }}
      >
        <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
          <path d="M8 6h13" />
          <path d="M8 12h13" />
          <path d="M8 18h13" />
          <path d="m3 6 1 1 2-2" />
          <path d="m3 12 1 1 2-2" />
          <path d="m3 18 1 1 2-2" />
        </svg>
        <span>{total > 0 ? `Rules · ${total}` : 'Rules'}</span>
      </button>

      <ComposerPopover anchorRef={anchorRef} open={open} onClose={() => setOpen(false)} align="start">
        <div
          role="dialog"
          aria-label="Rules governing this session"
          style={{
            width: 320,
            maxHeight: 420,
            overflowY: 'auto',
            paddingTop: 6,
            paddingRight: 5,
            paddingBottom: 6,
            paddingLeft: 5,
            borderRadius: 12,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--t-border)',
            background: 'var(--t-panel)',
            backdropFilter: 'blur(18px) saturate(1.3)',
            boxShadow: 'var(--t-panel-shadow)',
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            fontFamily: 'var(--font-sans-system)',
          }}
        >
          <SectionLabel>Session</SectionLabel>
          {sessionRules.length === 0 ? (
            <div style={{ fontSize: 11, fontWeight: 300, letterSpacing: '-0.1px', color: 'var(--t-text-faint)', paddingLeft: 8, paddingRight: 8, paddingTop: 2, paddingBottom: 4, lineHeight: 1.35 }}>
              No session rules yet. Rules added here bind every turn of this thread and every agent it dispatches.
            </div>
          ) : sessionRules.map((rule) => (
            <div key={rule.id} style={ruleRowStyle}>
              <TierBadge label="Session" />
              <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 300, letterSpacing: '-0.1px', lineHeight: 1.35, color: 'var(--t-text)', overflowWrap: 'anywhere' }}>
                {rule.text}
              </span>
              <button
                type="button"
                onClick={() => { void handleRemove(rule.id); }}
                aria-label="Remove rule"
                title="Remove this session rule"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 18,
                  height: 18,
                  borderRadius: 5,
                  borderWidth: 0,
                  background: 'transparent',
                  color: 'var(--t-text-faint)',
                  cursor: 'pointer',
                  fontSize: 13,
                  lineHeight: 1,
                  flexShrink: 0,
                }}
                onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--t-text)'; event.currentTarget.style.background = 'var(--t-hover)'; }}
                onMouseLeave={(event) => { event.currentTarget.style.color = 'var(--t-text-faint)'; event.currentTarget.style.background = 'transparent'; }}
              >
                &times;
              </button>
            </div>
          ))}

          {threadId ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, paddingLeft: 8, paddingRight: 6, paddingTop: 2, paddingBottom: 4 }}>
              <input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void handleAdd();
                  }
                  event.stopPropagation();
                }}
                placeholder="Add a session rule…"
                aria-label="Add a session rule"
                disabled={pending}
                style={{
                  flex: 1,
                  minWidth: 0,
                  height: 26,
                  paddingLeft: 8,
                  paddingRight: 8,
                  borderRadius: 6,
                  borderWidth: 1,
                  borderStyle: 'solid',
                  borderColor: 'var(--t-border)',
                  background: 'var(--t-input-bg)',
                  color: 'var(--t-text)',
                  fontSize: 11.5,
                  fontWeight: 300,
                  letterSpacing: '-0.1px',
                  fontFamily: 'var(--font-sans-system)',
                  outline: 'none',
                }}
              />
              <button
                type="button"
                onClick={() => { void handleAdd(); }}
                disabled={!draft.trim() || pending}
                aria-label="Add rule"
                style={{
                  height: 26,
                  paddingLeft: 8,
                  paddingRight: 8,
                  borderRadius: 6,
                  borderWidth: 0,
                  background: draft.trim() ? 'var(--t-accent-soft)' : 'transparent',
                  color: draft.trim() ? 'var(--t-accent)' : 'var(--t-text-faint)',
                  cursor: draft.trim() && !pending ? 'pointer' : 'default',
                  fontSize: 11,
                  fontWeight: 300,
                  letterSpacing: '-0.1px',
                  fontFamily: 'var(--font-sans-system)',
                  flexShrink: 0,
                }}
              >
                Add
              </button>
            </div>
          ) : (
            <div style={{ fontSize: 10.5, fontWeight: 300, letterSpacing: '-0.1px', color: 'var(--t-text-faint)', paddingLeft: 8, paddingRight: 8, paddingBottom: 4, lineHeight: 1.35 }}>
              Send a message to start the thread, then add session rules.
            </div>
          )}

          <SectionLabel>Repo</SectionLabel>
          {repoDirectives.length === 0 ? (
            <div style={{ fontSize: 11, fontWeight: 300, letterSpacing: '-0.1px', color: 'var(--t-text-faint)', paddingLeft: 8, paddingRight: 8, paddingBottom: 4 }}>
              No repo directives.
            </div>
          ) : repoDirectives.map((directive) => (
            <div key={directive.id} style={ruleRowStyle}>
              <TierBadge label="Repo" />
              <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontSize: 12, fontWeight: 300, letterSpacing: '-0.1px', lineHeight: 1.3, color: 'var(--t-text)', overflowWrap: 'anywhere' }}>
                  {directive.title}
                </span>
                <span style={{ fontSize: 9.5, fontWeight: 300, letterSpacing: '-0.4px', color: 'var(--t-text-faint)' }}>
                  Cortex directive · {directive.repoName || directive.scope}
                </span>
              </span>
            </div>
          ))}

          <SectionLabel>Global</SectionLabel>
          {globalDirectives.length === 0 ? (
            <div style={{ fontSize: 11, fontWeight: 300, letterSpacing: '-0.1px', color: 'var(--t-text-faint)', paddingLeft: 8, paddingRight: 8, paddingBottom: 4 }}>
              No global directives.
            </div>
          ) : globalDirectives.map((directive) => (
            <div key={directive.id} style={ruleRowStyle}>
              <TierBadge label="Global" />
              <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontSize: 12, fontWeight: 300, letterSpacing: '-0.1px', lineHeight: 1.3, color: 'var(--t-text)', overflowWrap: 'anywhere' }}>
                  {directive.title}
                </span>
                <span style={{ fontSize: 9.5, fontWeight: 300, letterSpacing: '-0.4px', color: 'var(--t-text-faint)' }}>
                  Cortex directive · global scope
                </span>
              </span>
            </div>
          ))}
        </div>
      </ComposerPopover>
    </>
  );
}
