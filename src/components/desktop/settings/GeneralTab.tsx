'use client';

/**
 * GeneralTab — the General settings page (Cursor-parity pass).
 *
 * Collects the app-level, non-domain-specific settings that don't belong to
 * Dispatch, Voice, or Account: launch-at-login (native autostart) and the
 * crash/error-report privacy toggles. Both surfaces already had a real
 * backend elsewhere; this tab is where an operator expects to find them.
 *
 * - Launch at login persists through the Tauri bridge (autostart_set), so the
 *   Startup group only renders in the desktop shell.
 * - The Privacy rows write to the same /api/panel/operator-defaults route as
 *   the rest of operator defaults, with the same env-locked handling.
 */

import { useCallback, useEffect, useState } from 'react';

import {
  APP_FONT_STACK,
  RamsButton,
  SettingsSelect,
  TabHeading,
  SETTINGS_CONTENT_MAX_WIDTH,
  type SettingsTab,
} from './shared';
import { SettingsGroup, SettingsRow, ValuePill } from './grouped';
import { fetchOperatorDefaults } from './operator-defaults-client';
import {
  autostartIsEnabled,
  autostartSet,
  desktopClosePreferenceGet,
  desktopClosePreferenceSet,
  getDesktopInfo,
  isTauri,
  type DesktopClosePreference,
} from '@/lib/tauri/bridge';
import { primeQuietMode, setQuietMode, syncReviewNotificationSetting } from '@/lib/presentation/quiet-mode-client';
import { useEntitlement } from '@/lib/entitlement/context';
import { openExternalUrl } from '@/lib/desktop/open-external';
import {
  ENV_LOCKED_REASON,
  type OperatorDefaults,
  type OperatorDefaultsResponse,
} from './dispatch-shared';

const FOUNDERS_URL = 'https://o8.run/pricing';

// ── Minimal raw-SVG glyphs for row icon tiles (React icon libs don't render
//    inside the Tauri webview — raw <svg> only, per repo rules). ──

function PowerIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
      <line x1="12" y1="2" x2="12" y2="12" />
    </svg>
  );
}

function PresentIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M12 16v4" />
      <path d="M8 20h8" />
    </svg>
  );
}

function BellOffIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M18 8a6 6 0 0 0-9.3-5" />
      <path d="M6 9c0 7-3 7-3 9h13" />
      <path d="M10 21h4" />
      <line x1="3" y1="3" x2="21" y2="21" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

function StarIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M12 2l2.9 6.3 6.9.6-5.2 4.6 1.6 6.8L12 17.3 5.8 20.9l1.6-6.8L2.2 9.5l6.9-.6z" />
    </svg>
  );
}

function ArrowUpIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <line x1="12" y1="19" x2="12" y2="5" />
      <polyline points="5 12 12 5 19 12" />
    </svg>
  );
}

export function GeneralTab({ onNavigateTab }: { onNavigateTab?: (tab: SettingsTab) => void }) {
  void onNavigateTab;
  const tauri = isTauri();

  // ── Plan ──
  // GitHub identity now lives with repo/CLI and automation capabilities in
  // Git & PRs. This derivation still mirrors AccountBlock so the plan reads
  // identically wherever it appears.
  const { plan, founder, actualPlan, actualFounder } = useEntitlement();
  const isFounder = Boolean(founder || actualFounder) || plan === 'founder' || actualPlan === 'founder';
  const isPaid = plan === 'pro' || plan === 'team' || actualPlan === 'pro' || actualPlan === 'team';
  // Founders present as Pro (Q ruling 2026-07-27): the ladder reads Free/Pro/
  // Team; the founding serial lives on the settings-drawer account row only.
  const planLabel = plan === 'team' || actualPlan === 'team'
    ? 'Team'
    : isFounder || isPaid
      ? 'Pro'
      : 'Free Plan';

  // ── Launch at login (native autostart via the Tauri bridge) ──
  const [autostart, setAutostart] = useState(false);
  const [autostartBusy, setAutostartBusy] = useState(false);
  const [desktopPlatform, setDesktopPlatform] = useState<string | null>(null);
  const [closePreference, setClosePreference] = useState<DesktopClosePreference>('ask');
  const [closePreferenceBusy, setClosePreferenceBusy] = useState(false);

  useEffect(() => {
    if (!tauri) return;
    let alive = true;
    Promise.all([
      autostartIsEnabled(),
      getDesktopInfo(),
      desktopClosePreferenceGet(),
    ])
      .then(([enabled, desktop, preference]) => {
        if (!alive) return;
        setAutostart(enabled);
        setDesktopPlatform(desktop?.platform ?? null);
        setClosePreference(preference);
      })
      .catch(() => { /* leave default off */ });
    return () => { alive = false; };
  }, [tauri]);

  const handleAutostart = useCallback((next: boolean) => {
    setAutostart(next);
    setAutostartBusy(true);
    void autostartSet(next)
      .then(setAutostart)
      .finally(() => setAutostartBusy(false));
  }, []);

  const handleClosePreference = useCallback((next: string) => {
    if (next !== 'ask' && next !== 'background' && next !== 'quit') return;
    setClosePreference(next);
    setClosePreferenceBusy(true);
    void desktopClosePreferenceSet(next)
      .then(setClosePreference)
      .finally(() => setClosePreferenceBusy(false));
  }, []);

  const canConfigureClose = desktopPlatform === 'windows' || desktopPlatform === 'linux';

  // ── Operator defaults (crash-report privacy toggles) ──
  const [data, setData] = useState<OperatorDefaultsResponse | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyField, setBusyField] = useState<keyof OperatorDefaults | null>(null);
  const [quietModeBusy, setQuietModeBusy] = useState(false);

  const loadDefaults = useCallback(async () => {
    try {
      const response = await fetchOperatorDefaults();
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof payload.error === 'string' ? payload.error : 'Failed to load settings.');
      }
      const defaults = payload as OperatorDefaultsResponse;
      setData(defaults);
      // Quiet mode and the review-banner preference are enforced in the native
      // shell (overlay windows and the macOS banner live outside this document),
      // so every read pushes the current values down to it.
      primeQuietMode(defaults.values?.presentationQuietMode === true);
      void syncReviewNotificationSetting(defaults.values?.notificationsReviewReady !== 'off');
      setNotice(null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Failed to load settings.');
    }
  }, []);

  useEffect(() => { void loadDefaults(); }, [loadDefaults]);

  const updateField = useCallback(async <K extends keyof OperatorDefaults>(field: K, value: OperatorDefaults[K]) => {
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
      setData(payload as OperatorDefaultsResponse);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Failed to update setting.');
    } finally {
      setBusyField(null);
    }
  }, []);

  // Quiet mode is not a plain field write: the native shell has to take the
  // overlay windows down (and put them back) around the persist, so it goes
  // through the quiet-mode client rather than `updateField`.
  const toggleQuietMode = useCallback(async (next: boolean) => {
    setQuietModeBusy(true);
    setNotice(null);
    try {
      await setQuietMode(next);
      await loadDefaults();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Quiet mode could not be saved.');
    } finally {
      setQuietModeBusy(false);
    }
  }, [loadDefaults]);

  const values = data?.values;
  const sources = data?.sources;
  const shareUsage = values?.productTelemetryEnabled === true;
  const envLocked = (field: keyof OperatorDefaults) => sources?.[field] === 'env';
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
        title="general"
        subtitle="App-level basics: whether o8 launches with your machine, and what leaves it when something breaks."
      />

      {notice ? (
        <div style={{
          marginBottom: 28,
          paddingTop: 2,
          paddingBottom: 2,
          fontSize: 13,
          color: 'var(--t-text)',
          lineHeight: 1.55,
        }}>
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

      <section style={{ marginBottom: 28 }}>
        <SettingsGroup
          header="Plan"
          footnote="Your plan. GitHub identity, repo access, and automation now live together in Git & PRs. License keys activate in Plan & Billing."
        >
          <SettingsRow
            icon={<StarIcon />}
            label="Plan"
            accessory={<ValuePill tone={isFounder ? 'success' : 'default'}>{planLabel}</ValuePill>}
            divider={!isFounder}
          />
          {!isFounder && !isPaid ? (
            <SettingsRow
              icon={<ArrowUpIcon />}
              label="Upgrade to Pro"
              subtitle="o8 is free forever — founders fund the build and get managed inference for life, early access to everything new, and the founder theme. One-time, the first 250."
              accessory={
                <RamsButton variant="primary" onClick={() => openExternalUrl(FOUNDERS_URL)}>
                  Upgrade
                </RamsButton>
              }
            />
          ) : null}
        </SettingsGroup>
      </section>

      {tauri ? (
        <section>
          <SettingsGroup
            header="Startup"
            footnote={canConfigureClose
              ? 'Closing o8 quits when no agent is working. With active work, o8 can ask, stay available from the system tray, or stop the workers and quit.'
              : 'Launch o8 automatically when you log in, so the fleet, dictation, and the menu-bar tray are ready the moment you sit down.'}
          >
            <SettingsRow
              icon={<PowerIcon />}
              label="Launch at login"
              subtitle="Start o8 automatically when you sign in to your computer"
              checked={autostart}
              disabled={autostartBusy}
              onToggle={handleAutostart}
              divider={canConfigureClose}
            />
            {canConfigureClose ? (
              <SettingsRow
                icon={<PowerIcon />}
                label="When closing with active agents"
                subtitle="No active work always quits fully"
                accessory={(
                  <SettingsSelect
                    value={closePreference}
                    onChange={handleClosePreference}
                    disabled={closePreferenceBusy}
                    width={170}
                    options={[
                      { value: 'ask', label: 'Ask every time' },
                      { value: 'background', label: 'Keep working' },
                      { value: 'quit', label: 'Stop and quit' },
                    ]}
                  />
                )}
              />
            ) : null}
          </SettingsGroup>
        </section>
      ) : null}

      <section style={{ marginTop: tauri ? 28 : 0 }}>
        <SettingsGroup
          header="Presentation"
          footnote="Quiet mode is for a screen share, a demo, or a recording. It takes down the overlay windows o8 floats outside its own frame, stops onboarding cards, count pills and toasts, and silences review notifications. Approvals and errors still come through. Quiet mode hides noise, not the fact that o8 is blocked on you."
        >
          <SettingsRow
            icon={<PresentIcon />}
            label="Quiet mode"
            subtitle={quietModeBusy
              ? 'Applying…'
              : 'Suppress overlays, coach cards, non-critical pills and toasts, and review notifications'}
            checked={values?.presentationQuietMode === true}
            disabled={!values || quietModeBusy}
            onToggle={(next) => { void toggleQuietMode(next); }}
            divider
          />
          <SettingsRow
            icon={<BellOffIcon />}
            label="Review notifications"
            subtitle={values?.presentationQuietMode === true
              ? 'Held off while quiet mode is on'
              : 'Raise a desktop notification when a packet is ready for review. A parallel dispatch arrives as one notification, not one per packet.'}
            checked={values ? values.notificationsReviewReady === 'on' : true}
            disabled={!values || busyField === 'notificationsReviewReady' || values.presentationQuietMode === true}
            onToggle={(next) => {
              void updateField('notificationsReviewReady', next ? 'on' : 'off');
              void syncReviewNotificationSetting(next);
            }}
          />
        </SettingsGroup>
      </section>

      <section style={{ marginTop: 28 }}>
        <SettingsGroup
          header="Privacy"
          footnote="Product usage sends only the allowlisted event name and coarse booleans or runtime enum shown in the privacy documentation. Crash reports are a separate control and can contain scrubbed error context. All sharing is optional and off by default."
        >
          <SettingsRow
            icon={<ShieldIcon />}
            label="Share usage data"
            subtitle="Send allowlisted product events to help improve o8"
            checked={shareUsage}
            disabled={!values || busyField === 'productTelemetryEnabled'}
            onToggle={(next) => { void updateField('productTelemetryEnabled', next); }}
            divider={Boolean(values && sources)}
          />
          {values && sources ? (
            <>
              <SettingsRow
                icon={<ShieldIcon />}
                label="Share crash & error data — also required to send bug reports"
                subtitle={lockedSub('crashReportsEnabled', 'Send scrubbed error messages and stack traces. These may include repo-relative paths or nearby runtime context.')}
                checked={values.crashReportsEnabled}
                disabled={envLocked('crashReportsEnabled') || busyField === 'crashReportsEnabled'}
                onToggle={(next) => { void updateField('crashReportsEnabled', next); }}
                divider
              />
              <SettingsRow
                icon={<ShieldIcon />}
                label="Send local crash log to the o8 team"
                subtitle={lockedSub('telemetryOptIn', 'Upload the local ~/.o8/telemetry crash log, including stored error messages and stack traces')}
                checked={values.telemetryOptIn}
                disabled={envLocked('telemetryOptIn') || busyField === 'telemetryOptIn'}
                onToggle={(next) => { void updateField('telemetryOptIn', next); }}
              />
            </>
          ) : null}
        </SettingsGroup>
      </section>
    </div>
  );
}
