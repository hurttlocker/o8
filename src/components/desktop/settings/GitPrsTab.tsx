'use client';

/**
 * GitPrsTab — the Git & PRs settings page (Cursor-parity pass).
 *
 * Leads with the GitHub CONNECTION (identity / sign-in / GitHub App, shared with
 * the legacy Connectors tab via GitHubConnectionSections) so there is one GitHub
 * story, then the three operator knobs — each gating a real code site: the prefix
 * o8 puts on branches it opens from issues, whether agent commits carry a
 * Co-Authored-By trailer, and whether a PR row opens in the embedded panel or the
 * OS browser. Every knob write goes through the same gated
 * /api/panel/operator-defaults route as the Dispatch tab; env-sourced fields lock
 * with the reason in the subtitle.
 */

import { useCallback, useEffect, useState } from 'react';

import {
  APP_FONT_STACK,
  MONO_FONT_STACK,
  RAMS_CONTROL_ACTIVE_BORDER,
  RAMS_CONTROL_BG,
  RAMS_CONTROL_BORDER,
  SettingsSegmented,
  SETTINGS_CONTENT_MAX_WIDTH,
  TabHeading,
} from './shared';
import { SettingsGroup, SettingsRow } from './grouped';
import { GitHubConnectionSections, type GitHubConnectionProps } from './GitHubTab';
import {
  ENV_LOCKED_REASON,
  type OperatorDefaults,
  type OperatorDefaultsResponse,
  type PrLinkDestination,
} from './dispatch-shared';

// ── Minimal raw-SVG glyphs for row icon tiles ──

function BranchIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
}

function SignatureIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M20 20c-3.5 0-4-6-7-6-2 0-3 4-5 4-1.5 0-2-2-2-2" />
      <path d="M4 15c2-4 4-9 6-9 1.5 0 1 4-1 9" />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}

// ── Free-text branch-prefix field (commits on blur / Enter, not per keystroke) ──

function BranchPrefixField({ value, onCommit, disabled }: {
  value: string;
  onCommit: (next: string) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  // Re-seed the draft when the upstream value changes (after a save round-trips).
  const [seededValue, setSeededValue] = useState(value);
  if (value !== seededValue) {
    setSeededValue(value);
    setDraft(value);
  }

  const commit = () => {
    setFocused(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== value) onCommit(trimmed);
    else if (trimmed !== draft) setDraft(value);
  };

  return (
    <input
      type="text"
      value={draft}
      placeholder="issue"
      disabled={disabled}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      aria-label="Branch prefix"
      onChange={(event) => setDraft(event.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={commit}
      onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
      style={{
        minWidth: 160,
        minHeight: 32,
        paddingTop: 6,
        paddingBottom: 6,
        paddingLeft: 10,
        paddingRight: 10,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: focused ? RAMS_CONTROL_ACTIVE_BORDER : RAMS_CONTROL_BORDER,
        borderRadius: 9,
        background: RAMS_CONTROL_BG,
        color: 'var(--t-text)',
        fontSize: 12,
        fontFamily: MONO_FONT_STACK,
        letterSpacing: '-0.005em',
        opacity: disabled ? 0.6 : 1,
        cursor: disabled ? 'not-allowed' : 'text',
        outline: 'none',
        transition: 'border-color 150ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
    />
  );
}

export function GitPrsTab(github: GitHubConnectionProps) {
  const [data, setData] = useState<OperatorDefaultsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyField, setBusyField] = useState<keyof OperatorDefaults | null>(null);

  const loadDefaults = useCallback(async () => {
    try {
      const response = await fetch('/api/panel/operator-defaults', { cache: 'no-store' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof payload.error === 'string' ? payload.error : 'Failed to load Git & PR settings.');
      }
      setData(payload as OperatorDefaultsResponse);
      setNotice(null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Failed to load Git & PR settings.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDefaults();
  }, [loadDefaults]);

  const updateField = useCallback(<K extends keyof OperatorDefaults>(field: K, value: OperatorDefaults[K]) => {
    void (async () => {
      setBusyField(field);
      setNotice(null);
      try {
        const response = await fetch('/api/panel/operator-defaults', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [field]: value }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(typeof payload.error === 'string' ? payload.error : 'Failed to update setting.');
        }
        setData(payload as OperatorDefaultsResponse);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : 'Failed to update setting.');
      } finally {
        setBusyField(null);
      }
    })();
  }, []);

  const values = data?.values;
  const sources = data?.sources;

  const envLocked = (field: keyof OperatorDefaults) =>
    sources ? sources[field] === 'env' : false;
  const lockedSub = (field: keyof OperatorDefaults, normal: string) =>
    envLocked(field) ? ENV_LOCKED_REASON : normal;

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
        title="git & prs"
        subtitle="Connect GitHub and set how o8 names branches, attributes commits, and opens PRs."
      />

      {/* ── GitHub connection (identity / sign-in / GitHub App) ── */}
      <GitHubConnectionSections {...github} />

      {notice ? (
        <div style={{ marginTop: 28, fontSize: 13, color: 'var(--t-text)', lineHeight: 1.55 }}>
          <span style={{
            fontFamily: APP_FONT_STACK,
            fontSize: 11,
            fontWeight: 400,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color: '#ef4444',
            marginRight: 8,
          }}>
            [error]
          </span>
          {notice}
        </div>
      ) : null}

      {loading && !data ? (
        <div style={{ marginTop: 28, color: 'var(--t-text-muted)', fontSize: 13, fontFamily: APP_FONT_STACK }}>
          Loading Git &amp; PR settings...
        </div>
      ) : !values || !sources ? (
        <div style={{ marginTop: 28, color: 'var(--t-brand-red, #b91c1c)', fontSize: 13, fontFamily: APP_FONT_STACK }}>
          {notice ?? 'Unable to load Git & PR settings.'}
        </div>
      ) : (
        <>
          <section style={{ marginTop: 28 }}>
            <SettingsGroup
              header="Branches"
              footnote="o8 opens one branch per packet it starts from a GitHub issue, named prefix/<number>-<title>. Inline drafts you type in the composer keep their own inline/ marker."
            >
              <SettingsRow
                icon={<BranchIcon />}
                label="Branch prefix"
                subtitle={lockedSub('branchPrefix', `Branches from issues are named ${values.branchPrefix}/<number>-<title>`)}
                accessory={
                  <BranchPrefixField
                    value={values.branchPrefix}
                    onCommit={(next) => { updateField('branchPrefix', next); }}
                    disabled={envLocked('branchPrefix') || busyField === 'branchPrefix'}
                  />
                }
              />
            </SettingsGroup>
          </section>

          <section style={{ marginTop: 28 }}>
            <SettingsGroup
              header="Commits"
              footnote="When on, commits o8's agents create in their worktrees carry a Co-Authored-By trailer so the fleet's work is attributable in git history. Your own commits are never touched."
            >
              <SettingsRow
                icon={<SignatureIcon />}
                label="Tag commits created by agents"
                subtitle={lockedSub('commitAttributionEnabled', 'Append a Co-Authored-By: o8 agent trailer to agent commits')}
                checked={values.commitAttributionEnabled}
                disabled={envLocked('commitAttributionEnabled') || busyField === 'commitAttributionEnabled'}
                onToggle={(next) => { updateField('commitAttributionEnabled', next); }}
              />
            </SettingsGroup>
          </section>

          <section style={{ marginTop: 28 }}>
            <SettingsGroup
              header="Pull requests"
              footnote="In o8 opens the pull request inside the embedded review panel — diffs, checks, and comments without leaving the app. Browser hands it to your default browser on github.com instead."
            >
              <SettingsRow
                icon={<LinkIcon />}
                label="Open pull requests"
                subtitle={lockedSub('prLinkDestination', 'Where a PR row opens when you click it')}
                accessory={
                  <SettingsSegmented
                    value={values.prLinkDestination}
                    onChange={(next) => { updateField('prLinkDestination', next as PrLinkDestination); }}
                    options={[
                      { value: 'in-app', label: 'In o8' },
                      { value: 'browser', label: 'Browser' },
                    ]}
                  />
                }
              />
            </SettingsGroup>
          </section>
        </>
      )}
    </div>
  );
}
