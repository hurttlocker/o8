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

// ── Source-file grouping (#1346) ──
// Spec-ingest writes directive titles as `<repoSlug>/<relPath> — <heading>`
// (see spec-ingest.ts). Recover the source file so a wall of ingested rows can
// collapse to "N directives — from AGENTS.md, CLAUDE.md, …" and group on expand.
// Operator-authored directives that don't follow the format land under "Other".
function directiveSourceFile(d: DirectiveRow): string {
  const dash = d.title.indexOf(' — ');
  if (dash === -1) return 'Other';
  let src = d.title.slice(0, dash).trim();
  if (d.repoName && src.startsWith(`${d.repoName}/`)) src = src.slice(d.repoName.length + 1);
  return src || 'Other';
}

/** Section heading (the part after ` — `); the whole title when there's no prefix. */
function directiveHeading(d: DirectiveRow): string {
  const dash = d.title.indexOf(' — ');
  if (dash === -1) return d.title;
  return d.title.slice(dash + 3).trim() || d.title;
}

/** Group directives by source file, preserving first-seen order. */
function groupBySource(rows: DirectiveRow[]): Array<[string, DirectiveRow[]]> {
  const map = new Map<string, DirectiveRow[]>();
  for (const d of rows) {
    const key = directiveSourceFile(d);
    const bucket = map.get(key);
    if (bucket) bucket.push(d); else map.set(key, [d]);
  }
  return Array.from(map.entries());
}

/** Distinct source files in first-seen order — powers the collapsed summary. */
function distinctSources(rows: DirectiveRow[]): string[] {
  const seen: string[] = [];
  for (const d of rows) {
    const key = directiveSourceFile(d);
    if (!seen.includes(key)) seen.push(key);
  }
  return seen;
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

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
      style={{ display: 'block', flexShrink: 0, transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 120ms' }}>
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

/**
 * An inherited directive tier (Repo / Global). Collapsed by default to a single
 * summary row so a spec-ingested repo (100+ directives) reads as "what governs
 * this session," not a file dump (#1346). Expands to the directives grouped by
 * source file. An empty tier renders its labelled zero-state, no toggle.
 */
function CollapsibleDirectiveTier({ badgeLabel, nounLabel, rows, expanded, onToggle }: {
  badgeLabel: string;
  nounLabel: string;
  rows: DirectiveRow[];
  expanded: boolean;
  onToggle: () => void;
}) {
  if (rows.length === 0) {
    return (
      <>
        <SectionLabel>{badgeLabel}</SectionLabel>
        <div style={{ fontSize: 11, fontWeight: 300, letterSpacing: '-0.1px', color: 'var(--t-text-faint)', paddingLeft: 8, paddingRight: 8, paddingBottom: 4 }}>
          No {nounLabel} directives.
        </div>
      </>
    );
  }

  const sources = distinctSources(rows);
  const preview = sources.length > 4 ? `${sources.slice(0, 3).join(', ')} +${sources.length - 3} more` : sources.join(', ');
  const groups = groupBySource(rows);

  return (
    <>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={`${rows.length} ${nounLabel} directive${rows.length === 1 ? '' : 's'}${sources.length ? ` from ${sources.join(', ')}` : ''}`}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left',
          paddingTop: 6, paddingBottom: 6, paddingLeft: 8, paddingRight: 6, borderRadius: 6,
          borderWidth: 0, background: 'transparent', cursor: 'pointer', fontFamily: 'var(--font-sans-system)',
          transition: 'background 120ms',
        }}
        onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--t-hover)'; }}
        onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
      >
        <TierBadge label={badgeLabel} />
        <span style={{ flex: 1, minWidth: 0, fontSize: 11.5, fontWeight: 300, letterSpacing: '-0.1px', lineHeight: 1.3, color: 'var(--t-text-secondary)', overflowWrap: 'anywhere' }}>
          {rows.length} {nounLabel} directive{rows.length === 1 ? '' : 's'}{preview ? ` — from ${preview}` : ''}
        </span>
        <span style={{ display: 'inline-flex', color: 'var(--t-text-faint)', flexShrink: 0 }}>
          <Chevron expanded={expanded} />
        </span>
      </button>
      {expanded && groups.map(([source, groupRows]) => (
        <div key={source} style={{ display: 'flex', flexDirection: 'column', gap: 1, paddingLeft: 10, paddingBottom: 2 }}>
          <div style={{ fontSize: 9, fontWeight: 300, letterSpacing: '0.02em', color: 'var(--t-text-faint)', paddingLeft: 8, paddingTop: 3, paddingBottom: 1 }}>
            {source} · {groupRows.length}
          </div>
          {groupRows.map((directive) => (
            <div key={directive.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, paddingTop: 2, paddingBottom: 2, paddingLeft: 8, paddingRight: 6 }}>
              <span style={{ flex: 1, minWidth: 0, fontSize: 11.5, fontWeight: 300, letterSpacing: '-0.1px', lineHeight: 1.3, color: 'var(--t-text)', overflowWrap: 'anywhere' }}>
                {directiveHeading(directive)}
              </span>
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

export function SessionRulesChip({ threadId, repoPath }: SessionRulesChipProps) {
  const anchorRef = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [sessionRules, setSessionRules] = useState<SessionRule[]>([]);
  const [directives, setDirectives] = useState<DirectiveRow[]>([]);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  // STYLEGUIDE §1 busy state, §2 sibling cohesion with Add's `pending`: the
  // pressed × disables until its DELETE round-trip lands.
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [hovered, setHovered] = useState(false);
  // Inherited tiers collapse to a summary row by default (#1346).
  const [repoExpanded, setRepoExpanded] = useState(false);
  const [globalExpanded, setGlobalExpanded] = useState(false);

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
  // Slash-command hooks (Q ruling 2026-07-11): `/rules` opens this manager even
  // when the chip is hidden (no rules yet); `/rule <text>` posts a rule then
  // fires 'changed' so the count + visibility refresh.
  useEffect(() => {
    const openManager = () => setOpen(true);
    const reload = () => { void loadSessionRules(); };
    window.addEventListener('o8:open-session-rules', openManager);
    window.addEventListener('o8:session-rules-changed', reload);
    return () => {
      window.removeEventListener('o8:open-session-rules', openManager);
      window.removeEventListener('o8:session-rules-changed', reload);
    };
  }, [loadSessionRules]);

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
    if (removingId) return;
    setRemovingId(id);
    try {
      const res = await fetch(`/api/orchestrator/session-rules?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      const data = await res.json().catch(() => null) as { ok?: boolean } | null;
      if (data?.ok) await loadSessionRules();
    } catch (error) {
      console.warn('[session-rules] remove failed', error);
    } finally {
      setRemovingId(null);
    }
  }, [removingId, loadSessionRules]);

  const repoDirectives = directives.filter((d) => !isGlobalScope(d.scope));
  const globalDirectives = directives.filter((d) => isGlobalScope(d.scope));
  // Chip counts SESSION rules only — the operator's own rules — so a spec-ingested
  // repo's 100+ inherited directives don't bury the number that means "mine" (#1346).
  // The popover carries the full per-tier breakdown.
  const sessionCount = sessionRules.length;
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
      {/* Only surfaces once the operator has session rules (Q ruling
          2026-07-11) — a clean composer otherwise. When hidden, the anchor
          stays as a 0-width span so `/rules` can still open the manager
          against a stable position. Add the first rule via `/rule <text>`. */}
      {sessionCount > 0 ? (
        <button
          ref={anchorRef as React.RefObject<HTMLButtonElement>}
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          aria-label={`Session rules — ${sessionCount} session, ${repoDirectives.length} repo, ${globalDirectives.length} global`}
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
          <span>{`Rules · ${sessionCount}`}</span>
        </button>
      ) : (
        <span ref={anchorRef as React.RefObject<HTMLSpanElement>} aria-hidden style={{ display: 'inline-block', width: 0, height: 24, flexShrink: 0 }} />
      )}

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
                disabled={removingId !== null}
                aria-label={removingId === rule.id ? 'Removing rule…' : 'Remove rule'}
                aria-busy={removingId === rule.id}
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
                  cursor: removingId ? 'default' : 'pointer',
                  opacity: removingId === rule.id ? 0.45 : 1,
                  fontSize: 13,
                  lineHeight: 1,
                  flexShrink: 0,
                }}
                onMouseEnter={(event) => {
                  if (removingId) return;
                  event.currentTarget.style.color = 'var(--t-text)';
                  event.currentTarget.style.background = 'var(--t-hover)';
                }}
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

          <CollapsibleDirectiveTier
            badgeLabel="Repo"
            nounLabel="repo"
            rows={repoDirectives}
            expanded={repoExpanded}
            onToggle={() => setRepoExpanded((prev) => !prev)}
          />

          <CollapsibleDirectiveTier
            badgeLabel="Global"
            nounLabel="global"
            rows={globalDirectives}
            expanded={globalExpanded}
            onToggle={() => setGlobalExpanded((prev) => !prev)}
          />
        </div>
      </ComposerPopover>
    </>
  );
}
