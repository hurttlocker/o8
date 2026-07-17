'use client';

/**
 * WorktreeRetentionSection — the Worktrees retention settings surface
 * (Cursor-parity wave 2, analog of Cursor's Workspaces page).
 *
 * Two operator knobs that bound how much `.cortex-worktrees` disk o8 keeps:
 * a max worktree COUNT and a max total SIZE (GB). Both write through the same
 * gated /api/panel/operator-defaults route as the Dispatch / Git & PRs tabs and
 * are enforced OLDEST-FIRST at the WorktreeManager prune seam — the guard only
 * ever removes terminal-lane / orphan worktrees with a clean git status, never
 * active work. A status row reads the live count + measured size across repos.
 *
 * Exported as a standalone section; the orchestrator mounts it (no nav wiring
 * here). Self-contained: it owns its own fetch/save and defines its own response
 * shape rather than coupling to the Dispatch tab's mirror type.
 */

import { useCallback, useEffect, useState } from 'react';

import { APP_FONT_STACK, MONO_FONT_STACK, RAMS_CONTROL_BG, RAMS_CONTROL_BORDER, SETTINGS_CONTENT_MAX_WIDTH, TabHeading } from './shared';
import { SettingsGroup, SettingsRow, ValuePill } from './grouped';
import { fetchOperatorDefaults } from './operator-defaults-client';

const ENV_LOCKED_REASON = 'Locked by an environment variable — unset it to manage from Settings.';

type RetentionField = 'worktreeMaxCount' | 'worktreeMaxTotalGb';
type SettingSource = 'env' | 'file' | 'default';

interface DefaultsResponse {
  values: Record<string, unknown> & { worktreeMaxCount: number; worktreeMaxTotalGb: number };
  sources: Record<string, SettingSource>;
}

interface UsageResponse {
  totalCount: number;
  totalBytes: number;
  totalGb: number;
  repos: Array<{ name: string; path: string; count: number; bytes: number }>;
}

// ── Icons ──

function StackIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 17 12 22 22 17" />
      <polyline points="2 12 12 17 22 12" />
    </svg>
  );
}

function DiskIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v14a9 3 0 0 0 18 0V5" />
      <path d="M3 12a9 3 0 0 0 18 0" />
    </svg>
  );
}

function GaugeIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M12 21a9 9 0 1 0-9-9" />
      <path d="M12 12l4-3" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
    </svg>
  );
}

// ── Stepper ──

function Stepper({ value, onChange, step, min, max, unit, disabled }: {
  value: number;
  onChange: (next: number) => void;
  step: number;
  min: number;
  max: number;
  unit?: string;
  disabled?: boolean;
}) {
  const btn = (label: string, delta: number, ariaLabel: string) => {
    const next = Math.max(min, Math.min(max, value + delta));
    const atEdge = next === value;
    const off = disabled || atEdge;
    return (
      <button
        type="button"
        aria-label={ariaLabel}
        disabled={off}
        onClick={() => { if (!off) onChange(next); }}
        style={{
          width: 30,
          height: 30,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: RAMS_CONTROL_BORDER,
          borderRadius: 8,
          background: RAMS_CONTROL_BG,
          color: 'var(--t-text)',
          fontSize: 16,
          fontFamily: APP_FONT_STACK,
          lineHeight: 1,
          cursor: off ? 'not-allowed' : 'pointer',
          opacity: off ? 0.4 : 1,
          transition: 'opacity 120ms ease',
        }}
      >
        {label}
      </button>
    );
  };

  const display = value <= 0 ? '∞' : `${value}${unit ? ` ${unit}` : ''}`;

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
      {btn('−', -step, 'Decrease')}
      <span style={{
        minWidth: 56,
        textAlign: 'center',
        fontFamily: MONO_FONT_STACK,
        fontSize: 12.5,
        color: 'var(--t-text)',
        letterSpacing: '-0.005em',
      }}>
        {display}
      </span>
      {btn('+', step, 'Increase')}
    </span>
  );
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 GB';
  const gb = bytes / 1024 / 1024 / 1024;
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`;
  const mb = bytes / 1024 / 1024;
  return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
}

export function WorktreeRetentionSection() {
  const [data, setData] = useState<DefaultsResponse | null>(null);
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyField, setBusyField] = useState<RetentionField | null>(null);

  const loadDefaults = useCallback(async () => {
    try {
      const response = await fetchOperatorDefaults();
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof payload.error === 'string' ? payload.error : 'Failed to load worktree settings.');
      }
      setData(payload as DefaultsResponse);
      setNotice(null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Failed to load worktree settings.');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadUsage = useCallback(async () => {
    try {
      const response = await fetch('/api/worktrees/retention-usage', { cache: 'no-store' });
      const payload = await response.json().catch(() => ({}));
      if (response.ok) setUsage(payload as UsageResponse);
    } catch {
      // Non-fatal — the status row simply shows a dash.
    }
  }, []);

  useEffect(() => {
    void loadDefaults();
    void loadUsage();
  }, [loadDefaults, loadUsage]);

  const updateField = useCallback((field: RetentionField, value: number) => {
    void (async () => {
      setBusyField(field);
      setNotice(null);
      try {
        const response = await fetchOperatorDefaults({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [field]: value }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(typeof payload.error === 'string' ? payload.error : 'Failed to update setting.');
        }
        setData(payload as DefaultsResponse);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : 'Failed to update setting.');
      } finally {
        setBusyField(null);
      }
    })();
  }, []);

  if (loading && !data) {
    return (
      <div style={{ paddingTop: 40, color: 'var(--t-text-muted)', fontSize: 13, fontFamily: APP_FONT_STACK }}>
        Loading worktree settings...
      </div>
    );
  }

  const values = data?.values;
  const sources = data?.sources;

  if (!values || !sources) {
    return (
      <div style={{ paddingTop: 40, color: 'var(--t-brand-red, #b91c1c)', fontSize: 13, fontFamily: APP_FONT_STACK }}>
        {notice ?? 'Unable to load worktree settings.'}
      </div>
    );
  }

  const envLocked = (field: RetentionField) => sources[field] === 'env';
  const lockedSub = (field: RetentionField, normal: string) => (envLocked(field) ? ENV_LOCKED_REASON : normal);

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
        title="worktrees"
        subtitle="How much disk o8 keeps for the isolated worktrees it spins up per packet. When a repo exceeds either limit, the oldest safe worktrees are reclaimed first — never one with unmerged work or an active agent."
      />

      {notice ? (
        <div style={{ marginBottom: 28, fontSize: 13, color: 'var(--t-text)', lineHeight: 1.55 }}>
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

      <section>
        <SettingsGroup
          header="Retention"
          footnote="Limits are enforced during o8's periodic worktree sweep, oldest-first. A worktree is only ever removed when it backs no active or reviewing agent AND has a clean git status — a dirty tree is always skipped, and unmerged commits are preserved as a branch before its directory is reclaimed. Set a limit to 0 for unbounded (∞)."
        >
          <SettingsRow
            icon={<StackIcon />}
            label="Max worktrees"
            subtitle={lockedSub('worktreeMaxCount', 'Most packet worktrees kept per repo before the oldest safe ones are pruned')}
            accessory={
              <Stepper
                value={values.worktreeMaxCount}
                onChange={(next) => { updateField('worktreeMaxCount', next); }}
                step={1}
                min={0}
                max={200}
                disabled={envLocked('worktreeMaxCount') || busyField === 'worktreeMaxCount'}
              />
            }
            divider
          />
          <SettingsRow
            icon={<GaugeIcon />}
            label="Max total size"
            subtitle={lockedSub('worktreeMaxTotalGb', 'Total on-disk size of packet worktrees per repo before the oldest safe ones are pruned')}
            accessory={
              <Stepper
                value={values.worktreeMaxTotalGb}
                onChange={(next) => { updateField('worktreeMaxTotalGb', next); }}
                step={5}
                min={0}
                max={500}
                unit="GB"
                disabled={envLocked('worktreeMaxTotalGb') || busyField === 'worktreeMaxTotalGb'}
              />
            }
          />
        </SettingsGroup>
      </section>

      <section style={{ marginTop: 28 }}>
        <SettingsGroup
          header="On disk now"
          footnote="Measured across every connected repo's .cortex-worktrees directory."
        >
          <SettingsRow
            icon={<DiskIcon />}
            label="Current usage"
            subtitle={usage
              ? `${usage.totalCount} worktree${usage.totalCount === 1 ? '' : 's'} across ${usage.repos.length} repo${usage.repos.length === 1 ? '' : 's'}`
              : 'Measuring…'}
            accessory={
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <ValuePill>{usage ? formatBytes(usage.totalBytes) : '—'}</ValuePill>
                <button
                  type="button"
                  aria-label="Refresh usage"
                  onClick={() => { void loadUsage(); }}
                  style={{
                    height: 30,
                    paddingLeft: 12,
                    paddingRight: 12,
                    borderWidth: 1,
                    borderStyle: 'solid',
                    borderColor: RAMS_CONTROL_BORDER,
                    borderRadius: 8,
                    background: RAMS_CONTROL_BG,
                    color: 'var(--t-text-secondary)',
                    fontSize: 12,
                    fontFamily: APP_FONT_STACK,
                    cursor: 'pointer',
                  }}
                >
                  Refresh
                </button>
              </span>
            }
          />
        </SettingsGroup>
      </section>
    </div>
  );
}
