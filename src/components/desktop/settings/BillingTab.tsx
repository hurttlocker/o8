'use client';

/**
 * BillingTab — Plan & Billing settings surface.
 *
 * Separates free local workspace features, plan-dependent hosted services,
 * and planned services. License activation uses the existing entitlement API.
 *
 * The global EntitlementProvider (useEntitlement) loads once on mount and has
 * no refresh hook, so this tab keeps a LOCAL copy fetched from the same route
 * and refreshes it after each POST. A full reload re-syncs the provider.
 */

import { useCallback, useEffect, useState } from 'react';

import { useEntitlement } from '@/lib/entitlement/context';
import type { Plan } from '@/lib/entitlement/types';

import {
  APP_FONT_STACK,
  MONO_FONT_STACK,
  RAMS_ACCENT,
  RAMS_CONTROL_BG,
  RAMS_CONTROL_BORDER,
  RAMS_CONTROL_ACTIVE_BORDER,
  RAMS_INK_QUIET,
  BracketLabel,
  KeyIcon,
  RamsButton,
  TabHeading,
  SETTINGS_CONTENT_MAX_WIDTH,
} from './shared';
import { SettingsGroup, SettingsRow, ValuePill } from './grouped';

const UPGRADE_URL = 'https://o8.run/pricing';

type EntitlementSource = 'env' | 'file' | 'default';

interface EntitlementResponse {
  plan?: unknown;
  source?: unknown;
}

interface PostError {
  ok: false;
  reason: string;
}

// The founder plan presents as Pro (Q ruling 2026-07-27): plan ids stay
// frozen, but the ladder reads Free/Pro/Team everywhere. Founding identity is
// the serial chip on the settings-drawer account row, not a plan name.
const PLAN_LABELS: Record<Plan, string> = {
  free: 'Free',
  pro: 'Pro',
  team: 'Team',
  founder: 'Pro',
};

const PLAN_TAGLINES: Record<Plan, string> = {
  free: 'Use the local workspace with your own connected AI tools. Your providers may charge for usage.',
  pro: 'Adds hosted o8 High and Engineering Brain assistance, subject to your plan limits. Hosted mobile and cloud execution are planned.',
  team: 'Your team plan and active license determine hosted access and limits. Planned services are listed separately below.',
  founder: 'Your founding license provides Pro access and its included benefits. Hosted usage remains subject to plan limits.',
};

const INCLUDED_ROWS: Array<{ label: string; detail: string }> = [
  { label: 'Orchestrator & workers', detail: 'Plan and run tasks with your connected AI tools.' },
  { label: 'Code review & approvals', detail: 'Review completed work and control when changes can merge.' },
  { label: 'Projects & repositories', detail: 'Share project instructions and coordinate work across repositories.' },
  { label: 'Voice & dictation', detail: 'Use supported local voice features or connect your own voice provider.' },
];

const COMING_ROWS: Array<{ label: string; detail: string }> = [
  { label: 'Fully hosted mobile', detail: 'Planned mobile services running on o8 infrastructure.' },
  { label: 'Cloud execution', detail: 'Planned hosted workers that can run independently of your computer.' },
];

function coercePlan(value: unknown): Plan {
  return value === 'pro' || value === 'team' || value === 'founder' ? value : 'free';
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

function SoonGlyph() {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke={RAMS_INK_QUIET} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
}

export function BillingTab() {
  // The entitlement provider is the plan truth for DISPLAY — the founder record
  // is machine-local (~/.o8) and survives Clerk sign-out, so the card must not
  // read "Free" just because the drawer is signed out (#1624). The local fetch
  // below still owns the license controls, which need a post-POST refresh.
  const entitlement = useEntitlement();
  const [plan, setPlan] = useState<Plan>('free');
  const [source, setSource] = useState<EntitlementSource>('default');
  const [loading, setLoading] = useState(true);
  const [licenseInput, setLicenseInput] = useState('');
  const [busy, setBusy] = useState<'apply' | 'clear' | null>(null);
  const [licenseOpen, setLicenseOpen] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const applyEntitlement = useCallback((data: EntitlementResponse) => {
    setPlan(coercePlan(data.plan));
    setSource(coerceSource(data.source));
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
  const hasFileLicense = source === 'file';

  // Mirrors GeneralTab's derivation so the ladder reads identically wherever it
  // appears: either the local fetch or the entitlement provider (effective or
  // pre-view-as-clamp) claiming a tier is enough to show it.
  const isFounder = Boolean(entitlement.founder || entitlement.actualFounder)
    || plan === 'founder' || entitlement.plan === 'founder' || entitlement.actualPlan === 'founder';
  const isTeam = plan === 'team' || entitlement.plan === 'team' || entitlement.actualPlan === 'team';
  const isPaid = isFounder || isTeam || plan === 'pro' || entitlement.plan === 'pro' || entitlement.actualPlan === 'pro';
  // Founders present as Pro via PLAN_LABELS, but keep the founder tagline.
  const displayPlan: Plan = isTeam ? 'team' : isFounder ? 'founder' : isPaid ? 'pro' : 'free';

  // License controls stay on the LOCAL copy — clearing is only meaningful for a
  // license this machine actually stores.
  const canClearLicense = !envManaged && (plan === 'pro' || plan === 'team' || hasFileLicense);

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
      paddingRight: 8,
      paddingBottom: 40,
      maxWidth: SETTINGS_CONTENT_MAX_WIDTH,
      fontFamily: APP_FONT_STACK,
    }}>
      <TabHeading
        title="plan & billing"
        subtitle="Manage your o8 plan and license. The local workspace is free; hosted services depend on your plan."
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
            color: notice.tone === 'error' ? '#d94f3a' : RAMS_ACCENT,
            marginRight: 8,
          }}>
            {notice.tone === 'error' ? '[error]' : '[ok]'}
          </span>
          {notice.text}
        </div>
      ) : null}

      <section>
        <SettingsGroup header="Current plan">
          <div style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 20,
            paddingTop: 16,
            paddingBottom: 16,
            paddingLeft: 14,
            paddingRight: 14,
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
                  {PLAN_LABELS[displayPlan]}
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
                {PLAN_TAGLINES[displayPlan]}
              </p>
              {envManaged ? (
                <p style={{ fontSize: 11.5, color: RAMS_INK_QUIET, lineHeight: 1.5, marginTop: 2, marginBottom: 0 }}>
                  Plan is pinned by the{' '}
                  <span style={{ fontFamily: MONO_FONT_STACK, fontSize: 11 }}>O8_PLAN</span>{' '}
                  environment variable. Unset it to manage a license from here.
                </p>
              ) : null}
            </div>
            <div style={{ flexShrink: 0 }}>
              {!isPaid ? (
                <RamsButton
                  variant="ghost"
                  onClick={() => { window.open(UPGRADE_URL, '_blank', 'noopener,noreferrer'); }}
                >
                  View plans
                </RamsButton>
              ) : null}
            </div>
          </div>
        </SettingsGroup>
      </section>

      <section style={{ marginTop: 28 }}>
        <SettingsGroup
          header="Free workspace"
          footnote="These workspace features are free in o8. Connected AI and voice providers apply their own prices, subscriptions, and usage limits."
        >
          {INCLUDED_ROWS.map((row, idx) => (
            <SettingsRow
              key={row.label}
              icon={<CheckGlyph />}
              label={row.label}
              subtitle={row.detail}
              accessory={<ValuePill tone="success">Included</ValuePill>}
              divider={idx < INCLUDED_ROWS.length - 1}
            />
          ))}
        </SettingsGroup>
      </section>

      <section style={{ marginTop: 28 }}>
        <SettingsGroup header="Hosted services" footnote="Your active plan determines availability and usage limits. Provider keys and CLI subscriptions remain separate from your o8 license.">
          <SettingsRow icon={<CheckGlyph />} label="o8 High & Engineering Brain" subtitle="Hosted model access and repository assistance on o8 infrastructure." accessory={<ValuePill>{isPaid ? 'Plan access' : 'Pro'}</ValuePill>} />
        </SettingsGroup>
      </section>

      <section style={{ marginTop: 28 }}>
        <SettingsGroup
          header="Planned services"
          footnote="Roadmap items are not a promise of current availability. Existing mobile pairing and remote access are configured on their own settings pages."
        >
          {COMING_ROWS.map((row, idx) => (
            <SettingsRow
              key={row.label}
              icon={<SoonGlyph />}
              label={row.label}
              subtitle={row.detail}
              accessory={<ValuePill>Planned</ValuePill>}
              divider={idx < COMING_ROWS.length - 1}
            />
          ))}
        </SettingsGroup>
      </section>

      <section style={{ marginTop: 28 }}>
        <SettingsGroup
          footnote={licenseOpen
            ? <>Verified offline, stored locally in{' '}
              <span style={{ fontFamily: MONO_FONT_STACK, fontSize: 11 }}>~/.o8/entitlement.json</span>. Signing in with a founding account activates automatically — this is the manual path.</>
            : undefined}
        >
          <SettingsRow
            icon={<KeyIcon />}
            label="Have a license key?"
            subtitle={hasFileLicense ? 'A license is active on this machine' : 'Founding passes activate here — or just sign in'}
            accessory={hasFileLicense ? <ValuePill tone="success">Active</ValuePill> : undefined}
            onPress={() => setLicenseOpen((v) => !v)}
            chevron
            divider={licenseOpen}
          />
          {licenseOpen ? (
          <div style={{ paddingTop: 14, paddingBottom: 14, paddingLeft: 14, paddingRight: 14 }}>
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
                disabled={!canClearLicense}
                busy={busy === 'clear'}
              >
                {busy === 'clear' ? 'Clearing...' : 'Clear license'}
              </RamsButton>
            </div>
          </div>
          ) : null}
        </SettingsGroup>
      </section>
    </div>
  );
}
