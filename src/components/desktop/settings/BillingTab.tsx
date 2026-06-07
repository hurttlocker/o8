'use client';

/**
 * BillingTab — Plan & Billing settings surface (monetization M3).
 *
 * Shows the active plan, the flag matrix (which moats are unlocked), a
 * license-key paste field + Clear, and a PLACEHOLDER Upgrade CTA. License
 * apply/clear POSTs to /api/panel/entitlement (verifies via license.ts).
 *
 * The global EntitlementProvider (useEntitlement) loads once on mount and has
 * no refresh hook, so this tab keeps a LOCAL copy fetched from the same route
 * and refreshes it after each POST. A full reload re-syncs the provider — fine
 * for M3 (Clerk + live broadcast land in M5).
 */

import { useCallback, useEffect, useState } from 'react';

import type { EntitlementFlags, Plan } from '@/lib/entitlement/types';

import {
  APP_FONT_STACK,
  MONO_FONT_STACK,
  RAMS_ACCENT,
  RAMS_CONTROL_BG,
  RAMS_CONTROL_BORDER,
  RAMS_CONTROL_ACTIVE_BORDER,
  RAMS_HAIRLINE_SOFT,
  RAMS_INK_QUIET,
  BracketLabel,
  HairlineRule,
  RamsButton,
  SectionLabel,
  TabBreadcrumb,
  TabHeading,
  SETTINGS_CONTENT_MAX_WIDTH,
} from './shared';

const UPGRADE_URL = 'https://o8.run/pricing';

type EntitlementSource = 'env' | 'file' | 'default';

interface EntitlementResponse {
  plan?: unknown;
  flags?: unknown;
  source?: unknown;
}

interface PostError {
  ok: false;
  reason: string;
}

const PLAN_LABELS: Record<Plan, string> = {
  free: 'Free',
  pro: 'Pro',
  team: 'Team',
};

const PLAN_TAGLINES: Record<Plan, string> = {
  free: 'Orchestration, dispatch, and review on a single repo. All moats locked.',
  pro: 'Governance second-pass, Engineering Brain, multi-repo fleet, and mobile control unlocked.',
  team: 'Everything in Pro, plus shared/team governance.',
};

// Human labels for each flag in EntitlementFlags. Order is the display order.
const FLAG_ROWS: Array<{ key: keyof EntitlementFlags; label: string; detail: string }> = [
  { key: 'governance.secondPass', label: 'Governance second-pass', detail: 'AI second-pass review gate before merge.' },
  { key: 'memory.brain', label: 'Engineering Brain', detail: 'Organizational memory Q&A across the repo.' },
  { key: 'fleet.multiRepo', label: 'Multi-repo fleet', detail: 'Run the orchestrator across more than one repo.' },
  { key: 'mobile.control', label: 'Mobile operator control', detail: 'Drive approvals + dispatch from the mobile app.' },
  { key: 'team.shared', label: 'Team / shared governance', detail: 'Shared directives + audit across a team.' },
];

function coercePlan(value: unknown): Plan {
  return value === 'pro' || value === 'team' ? value : 'free';
}

function coerceSource(value: unknown): EntitlementSource {
  return value === 'env' || value === 'file' ? value : 'default';
}

function sourceLabel(source: EntitlementSource): string {
  if (source === 'env') return 'env override';
  if (source === 'file') return 'licensed';
  return 'default';
}

function CheckGlyph() {
  return (
    <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke={RAMS_ACCENT} strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function LockGlyph() {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke={RAMS_INK_QUIET} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function FlagRow({ label, detail, unlocked, isLast }: {
  label: string;
  detail: string;
  unlocked: boolean;
  isLast: boolean;
}) {
  return (
    <div
      style={{
        paddingTop: 14,
        paddingBottom: 14,
        paddingLeft: 2,
        paddingRight: 2,
        borderBottom: isLast ? 'none' : `1px solid ${RAMS_HAIRLINE_SOFT}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 20,
      }}
    >
      <div style={{ minWidth: 0, flex: '1 1 auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{
          fontSize: 14,
          fontWeight: 300,
          color: 'var(--t-text)',
          letterSpacing: '-0.01em',
          opacity: unlocked ? 1 : 0.6,
        }}>
          {label}
        </span>
        <span style={{ fontSize: 12, color: 'var(--t-text-secondary)', lineHeight: 1.5 }}>
          {detail}
        </span>
      </div>
      <div style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        {unlocked ? <CheckGlyph /> : <LockGlyph />}
        <span style={{
          fontFamily: MONO_FONT_STACK,
          fontSize: 10,
          fontWeight: 400,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color: unlocked ? RAMS_ACCENT : RAMS_INK_QUIET,
        }}>
          {unlocked ? 'Unlocked' : 'Locked'}
        </span>
      </div>
    </div>
  );
}

export function BillingTab() {
  const [plan, setPlan] = useState<Plan>('free');
  const [flags, setFlags] = useState<EntitlementFlags | null>(null);
  const [source, setSource] = useState<EntitlementSource>('default');
  const [loading, setLoading] = useState(true);
  const [licenseInput, setLicenseInput] = useState('');
  const [busy, setBusy] = useState<'apply' | 'clear' | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const applyEntitlement = useCallback((data: EntitlementResponse) => {
    const nextPlan = coercePlan(data.plan);
    setPlan(nextPlan);
    setSource(coerceSource(data.source));
    const f = data.flags && typeof data.flags === 'object' ? (data.flags as EntitlementFlags) : null;
    setFlags(f);
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/panel/entitlement', { cache: 'no-store' });
      if (!res.ok) throw new Error(`Failed to load entitlement (${res.status})`);
      const data = (await res.json()) as EntitlementResponse;
      applyEntitlement(data);
      setNotice(null);
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : 'Failed to load plan.' });
    } finally {
      setLoading(false);
    }
  }, [applyEntitlement]);

  useEffect(() => {
    void load();
  }, [load]);

  const applyLicense = useCallback(async () => {
    const key = licenseInput.trim();
    if (!key || busy) return;
    setBusy('apply');
    setNotice(null);
    try {
      const res = await fetch('/api/panel/entitlement', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ licenseKey: key }),
      });
      const data = (await res.json().catch(() => ({}))) as EntitlementResponse & Partial<PostError>;
      if (data && data.ok === false) {
        setNotice({ tone: 'error', text: `License rejected: ${data.reason ?? 'invalid license'}` });
        return;
      }
      applyEntitlement(data);
      setLicenseInput('');
      setNotice({ tone: 'ok', text: `Activated ${PLAN_LABELS[coercePlan(data.plan)]}. Reload o8 to apply everywhere.` });
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : 'Failed to apply license.' });
    } finally {
      setBusy(null);
    }
  }, [licenseInput, busy, applyEntitlement]);

  const clearLicense = useCallback(async () => {
    if (busy) return;
    setBusy('clear');
    setNotice(null);
    try {
      const res = await fetch('/api/panel/entitlement', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clear: true }),
      });
      const data = (await res.json().catch(() => ({}))) as EntitlementResponse & Partial<PostError>;
      if (data && data.ok === false) {
        setNotice({ tone: 'error', text: `Could not clear: ${data.reason ?? 'unknown error'}` });
        return;
      }
      applyEntitlement(data);
      setLicenseInput('');
      setNotice({ tone: 'ok', text: 'License cleared. Back on Free. Reload o8 to apply everywhere.' });
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : 'Failed to clear license.' });
    } finally {
      setBusy(null);
    }
  }, [busy, applyEntitlement]);

  const envManaged = source === 'env';
  const isPaid = plan === 'pro' || plan === 'team';

  if (loading) {
    return (
      <div style={{
        paddingTop: 40,
        color: 'var(--t-text-muted)',
        fontSize: 13,
        fontFamily: APP_FONT_STACK,
      }}>
        Loading plan...
      </div>
    );
  }

  return (
    <div style={{
      paddingTop: 8,
      paddingLeft: 8,
      paddingRight: 32,
      paddingBottom: 40,
      maxWidth: SETTINGS_CONTENT_MAX_WIDTH,
      fontFamily: APP_FONT_STACK,
    }}>
      <TabBreadcrumb tab="billing" />
      <TabHeading
        title="plan & billing"
        subtitle="o8 is open-core. Free covers single-repo orchestration; Pro and Team unlock the governance, memory, and fleet moats. Paste a license key to activate a paid plan."
      />

      {notice ? (
        <div style={{
          marginBottom: 28,
          fontSize: 13,
          color: 'var(--t-text)',
          lineHeight: 1.55,
        }}>
          <span style={{
            fontFamily: MONO_FONT_STACK,
            fontSize: 11,
            fontWeight: 300,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color: notice.tone === 'error' ? '#ef4444' : RAMS_ACCENT,
            marginRight: 8,
          }}>
            {notice.tone === 'error' ? '[error]' : '[ok]'}
          </span>
          {notice.text}
        </div>
      ) : null}

      {/* 01 — CURRENT PLAN */}
      <section style={{ marginBottom: 32 }}>
        <SectionLabel number="01">CURRENT PLAN</SectionLabel>
        <div style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 20,
          paddingTop: 16,
          paddingBottom: 20,
          borderTop: `1px solid ${RAMS_HAIRLINE_SOFT}`,
          borderBottom: `1px solid ${RAMS_HAIRLINE_SOFT}`,
          flexWrap: 'wrap',
        }}>
          <div style={{ minWidth: 0, flex: '1 1 320px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{
                fontSize: 24,
                fontWeight: 300,
                color: 'var(--t-text)',
                letterSpacing: '-0.03em',
                lineHeight: 1,
              }}>
                {PLAN_LABELS[plan]}
              </span>
              <BracketLabel tone={isPaid ? 'accent' : 'quiet'}>{sourceLabel(source)}</BracketLabel>
            </div>
            <p style={{
              fontSize: 13,
              color: 'var(--t-text-secondary)',
              lineHeight: 1.55,
              margin: 0,
              maxWidth: 520,
            }}>
              {PLAN_TAGLINES[plan]}
            </p>
            {envManaged ? (
              <p style={{ fontSize: 11.5, color: RAMS_INK_QUIET, lineHeight: 1.5, margin: 0, marginTop: 2 }}>
                Plan is pinned by the{' '}
                <span style={{ fontFamily: MONO_FONT_STACK, fontSize: 11 }}>O8_PLAN</span>{' '}
                environment variable. Unset it to manage a license from here.
              </p>
            ) : null}
          </div>
          <div style={{ flexShrink: 0 }}>
            {!isPaid ? (
              <RamsButton
                variant="primary"
                onClick={() => { window.open(UPGRADE_URL, '_blank', 'noopener,noreferrer'); }}
              >
                Upgrade
              </RamsButton>
            ) : null}
          </div>
        </div>
      </section>

      {/* 02 — UNLOCKED FEATURES (flag matrix) */}
      <section style={{ marginBottom: 32 }}>
        <SectionLabel number="02">UNLOCKED FEATURES</SectionLabel>
        <p style={{
          fontSize: 13,
          color: 'var(--t-text-secondary)',
          lineHeight: 1.55,
          maxWidth: 580,
          margin: 0,
          marginBottom: 12,
        }}>
          Each moat below is derived from your plan. Free locks them all; Pro unlocks the first four; Team adds shared governance.
        </p>
        <div style={{ borderTop: `1px solid ${RAMS_HAIRLINE_SOFT}` }}>
          {FLAG_ROWS.map((row, idx) => (
            <FlagRow
              key={row.key}
              label={row.label}
              detail={row.detail}
              unlocked={Boolean(flags?.[row.key])}
              isLast={idx === FLAG_ROWS.length - 1}
            />
          ))}
        </div>
      </section>

      {/* 03 — LICENSE KEY */}
      <section style={{ marginBottom: 32 }}>
        <SectionLabel number="03">LICENSE KEY</SectionLabel>
        <p style={{
          fontSize: 13,
          color: 'var(--t-text-secondary)',
          lineHeight: 1.55,
          maxWidth: 580,
          margin: 0,
          marginBottom: 14,
        }}>
          Paste the signed license key from your purchase confirmation. It is verified offline and stored locally in{' '}
          <span style={{ fontFamily: MONO_FONT_STACK, fontSize: 12 }}>~/.o8/entitlement.json</span>.
        </p>

        <textarea
          value={licenseInput}
          onChange={(event) => setLicenseInput(event.target.value)}
          placeholder="o8_live_..."
          spellCheck={false}
          rows={3}
          disabled={envManaged || busy !== null}
          style={{
            width: '100%',
            maxWidth: 640,
            resize: 'vertical',
            minHeight: 72,
            paddingTop: 12,
            paddingBottom: 12,
            paddingLeft: 14,
            paddingRight: 14,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: RAMS_CONTROL_BORDER,
            borderRadius: 12,
            background: RAMS_CONTROL_BG,
            color: 'var(--t-text)',
            fontFamily: MONO_FONT_STACK,
            fontSize: 12,
            lineHeight: 1.5,
            letterSpacing: '0.01em',
            outline: 'none',
            opacity: envManaged ? 0.55 : 1,
            cursor: envManaged ? 'not-allowed' : 'text',
            transition: 'border-color 150ms cubic-bezier(0.22, 1, 0.36, 1)',
          }}
          onFocus={(event) => { event.currentTarget.style.borderColor = RAMS_CONTROL_ACTIVE_BORDER; }}
          onBlur={(event) => { event.currentTarget.style.borderColor = RAMS_CONTROL_BORDER; }}
        />

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 14, flexWrap: 'wrap' }}>
          <RamsButton
            variant="primary"
            onClick={() => { void applyLicense(); }}
            disabled={envManaged || !licenseInput.trim()}
            busy={busy === 'apply'}
          >
            {busy === 'apply' ? 'Verifying...' : 'Apply license'}
          </RamsButton>
          <RamsButton
            variant="ghost"
            onClick={() => { void clearLicense(); }}
            disabled={envManaged || (!isPaid && source !== 'file')}
            busy={busy === 'clear'}
          >
            {busy === 'clear' ? 'Clearing...' : 'Clear license'}
          </RamsButton>
        </div>
      </section>

      {/* 04 — BILLING (placeholder) */}
      <section>
        <SectionLabel number="04">BILLING</SectionLabel>
        <p style={{
          fontSize: 13,
          color: 'var(--t-text-secondary)',
          lineHeight: 1.55,
          maxWidth: 580,
          margin: 0,
          marginBottom: 14,
        }}>
          Self-serve checkout and invoice management open on{' '}
          <span style={{ fontFamily: MONO_FONT_STACK, fontSize: 12 }}>o8.run/pricing</span>. In-app checkout lands in a
          later release.
        </p>
        <RamsButton
          variant="ghost"
          onClick={() => { window.open(UPGRADE_URL, '_blank', 'noopener,noreferrer'); }}
        >
          View pricing
        </RamsButton>
        <div style={{ marginTop: 18 }}>
          <HairlineRule />
        </div>
      </section>
    </div>
  );
}
