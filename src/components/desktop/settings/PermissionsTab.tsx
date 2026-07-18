'use client';

/**
 * PermissionsTab — the macOS permissions concierge (#1342).
 *
 * A live per-permission status surface: Microphone, Accessibility, Input
 * Monitoring, Screen Recording. Each row shows a status pill, a one-line "why
 * o8 needs this", and a Fix action. The app does everything except click the
 * final toggle:
 *   - For prompts it can fire itself (mic, input monitoring) it fires the real
 *     macOS prompt first; a denial (macOS won't re-prompt) deep-links the exact
 *     System Settings pane.
 *   - While the tab is visible it polls the non-prompting status commands at
 *     ~1s; when a permission flips to granted the row transitions to a granted
 *     state inline.
 *   - Accessibility / Input Monitoring / Screen Recording only take effect after
 *     a relaunch — when one of those flips to granted during the session the row
 *     surfaces a "Relaunch o8 to apply" button wired to the updater's restart.
 *
 * All native state reads live through the Tauri bridge (isTauri() guarded).
 * Inline styles only, var(--t-*) tokens, raw-SVG icons (repo rule: no React
 * icon components inside the Tauri webview). The status-shape logic lives in the
 * pure, unit-tested `permissions-model` module.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  isTauri,
  micPermissionGranted,
  requestMicAccess,
  accessibilityPermissionGranted,
  inputMonitoringGranted,
  requestInputMonitoring,
  screenCaptureGranted,
  openSystemSettings,
  restartApp,
} from '@/lib/tauri/bridge';
import { APP_FONT_STACK, RAMS_INK_QUIET, TabHeading, SETTINGS_CONTENT_MAX_WIDTH } from './shared';
import { SettingsGroup, SettingsRow, ValuePill } from './grouped';
import {
  PERMISSIONS,
  PERM_IDS,
  micStatus,
  boolStatus,
  permPillText,
  permPillTone,
  fixActionLabel,
  shouldPrompt,
  isFreshGrant,
  type PermId,
  type PermStatus,
  type PermMeta,
} from './permissions-model';

// ── Raw-SVG status glyphs (themed; mirror VoiceTab's vocabulary) ──

function CheckGlyph() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function XGlyph() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="#d94f3a" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function DashGlyph() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" style={{ display: 'block', flexShrink: 0, opacity: 0.5 }}>
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function statusGlyph(status: PermStatus) {
  if (status === 'granted') return <CheckGlyph />;
  if (status === 'denied') return <XGlyph />;
  return <DashGlyph />;
}

// ── Small action button (matches VoiceTab's Groq button geometry) ──

function RowButton({
  label,
  onClick,
  accent = false,
}: {
  label: string;
  onClick: () => void;
  accent?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        height: 26,
        paddingLeft: 12,
        paddingRight: 12,
        fontSize: 12,
        fontWeight: 400,
        letterSpacing: '-0.1px',
        fontFamily: APP_FONT_STACK,
        color: accent ? '#ffffff' : 'var(--t-text)',
        background: accent ? 'var(--t-accent)' : 'var(--t-input-bg)',
        border: accent ? '1px solid var(--t-accent)' : '1px solid var(--t-divider)',
        borderRadius: 7,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        flexShrink: 0,
      }}
    >
      {label}
    </button>
  );
}

type StatusMap = Record<PermId, PermStatus>;

const INITIAL_STATUS: StatusMap = {
  microphone: 'unknown',
  accessibility: 'unknown',
  'input-monitoring': 'unknown',
  'screen-recording': 'unknown',
};

export function PermissionsTab() {
  const tauri = isTauri();

  const [statuses, setStatuses] = useState<StatusMap>(INITIAL_STATUS);
  // Permissions the user GRANTED during this visit (was actionable → granted).
  // Drives the relaunch nag for the TCC-cached grants.
  const [grantedThisSession, setGrantedThisSession] = useState<Set<PermId>>(() => new Set());
  // Ref mirror so the poll comparison + fix handler read current status without
  // re-subscribing the interval on every tick.
  const statusRef = useRef<StatusMap>(INITIAL_STATUS);

  const refresh = useCallback(async () => {
    if (!tauri) return;
    const [mic, acc, input, screen] = await Promise.all([
      micPermissionGranted(),
      accessibilityPermissionGranted(),
      inputMonitoringGranted(),
      screenCaptureGranted(),
    ]);
    const next: StatusMap = {
      microphone: micStatus(mic),
      accessibility: boolStatus(acc),
      'input-monitoring': boolStatus(input),
      'screen-recording': boolStatus(screen),
    };
    const prev = statusRef.current;
    const freshly: PermId[] = [];
    for (const id of PERM_IDS) {
      if (isFreshGrant(prev[id], next[id])) freshly.push(id);
    }
    statusRef.current = next;
    setStatuses(next);
    if (freshly.length) {
      setGrantedThisSession((cur) => {
        const merged = new Set(cur);
        for (const id of freshly) merged.add(id);
        return merged;
      });
    }
  }, [tauri]);

  // Live grant detection — poll the non-prompting status commands at ~1s while
  // the tab is mounted; stop on unmount.
  useEffect(() => {
    if (!tauri) return;
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 1000);
    return () => clearInterval(timer);
  }, [tauri, refresh]);

  const handleFix = useCallback(async (meta: PermMeta) => {
    const status = statusRef.current[meta.id];
    // Microphone: prompt only when never-asked; a denial goes to Settings.
    if (meta.id === 'microphone') {
      if (shouldPrompt(meta, status)) {
        await requestMicAccess();
        return;
      }
      await openSystemSettings(meta.deepLink);
      return;
    }
    // Input Monitoring: its preflight can't tell never-asked from denied, so
    // fire the real prompt first (a no-op on an existing denial) and deep-link
    // when it doesn't land granted — covers both the fresh-ask and denied paths.
    if (meta.id === 'input-monitoring') {
      const granted = await requestInputMonitoring();
      if (!granted) await openSystemSettings(meta.deepLink);
      return;
    }
    // Accessibility + Screen Recording: no self-fireable prompt — deep-link.
    await openSystemSettings(meta.deepLink);
  }, []);

  const handleRelaunch = useCallback(() => { void restartApp(); }, []);

  return (
    <div
      style={{
        paddingTop: 8,
        paddingLeft: 8,
        paddingRight: 32,
        paddingBottom: 40,
        maxWidth: SETTINGS_CONTENT_MAX_WIDTH,
        fontFamily: APP_FONT_STACK,
      }}
    >
      <TabHeading
        title="permissions"
        subtitle="o8 needs a few macOS permissions to dictate, run the global hotkey, and see your screen. The app does everything except click the final toggle — grants here update live."
      />

      {!tauri ? (
        <p style={{ fontSize: 13, fontWeight: 300, color: 'var(--t-text-faint)', lineHeight: 1.55, maxWidth: 620 }}>
          macOS permissions are only manageable from the desktop app.
        </p>
      ) : (
        <section>
          <SettingsGroup
            header="macOS permissions"
            footnote="Grants update automatically while this tab is open. Accessibility, Input Monitoring, and Screen Recording only take effect after o8 relaunches — the row offers a one-click relaunch once you grant them."
          >
            {PERMISSIONS.map((meta, i) => {
              const status = statuses[meta.id];
              const granted = status === 'granted';
              const needsRelaunchNow = meta.needsRelaunch && granted && grantedThisSession.has(meta.id);
              return (
                <SettingsRow
                  key={meta.id}
                  icon={statusGlyph(status)}
                  label={meta.label}
                  subtitle={meta.why}
                  divider={i < PERMISSIONS.length - 1}
                  accessory={
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                      <ValuePill tone={permPillTone(status)}>{permPillText(status)}</ValuePill>
                      {needsRelaunchNow ? (
                        <RowButton label="Relaunch o8 to apply" accent onClick={handleRelaunch} />
                      ) : !granted && status !== 'unknown' ? (
                        <RowButton label={fixActionLabel(meta, status)} onClick={() => { void handleFix(meta); }} />
                      ) : null}
                    </span>
                  }
                />
              );
            })}
          </SettingsGroup>
        </section>
      )}

      <p
        style={{
          marginTop: 36,
          fontSize: 11,
          fontWeight: 300,
          color: RAMS_INK_QUIET,
          fontFamily: APP_FONT_STACK,
          letterSpacing: '0.04em',
          lineHeight: 1.6,
          maxWidth: 620,
        }}
      >
        o8 never uploads audio or screen captures — Microphone feeds on-device dictation, Screen Recording powers Symon&rsquo;s look-and-point. Everything stays local.
      </p>
    </div>
  );
}
