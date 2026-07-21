'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  MOBILE_BODY_TRACKING,
  MOBILE_CARD_RADIUS,
  MOBILE_HEADING_TRACKING,
  MOBILE_TOUCH_TARGET,
  formatAboutVersion,
  mobileFontFamily,
  type MobilePalette,
} from '@/app/mobile/mobile-approvals-shared';
import { mobileSafeBottom } from '@/app/mobile/mobile-shell-primitives';
import { isHapticEnabled, setHapticEnabled, triggerHaptic } from '@/lib/mobile/haptic';
import {
  getRuntimeCapability,
  listDispatchableRuntimes,
  type OrchestratorRuntime,
} from '@/lib/orchestrator/runtime-capabilities';
import {
  ICON_GITHUB,
  ICON_INFO,
  ICON_PALETTE,
  ICON_RESET,
  ICON_SHIELD_CHECK,
  ICON_SLIDERS,
  ICON_USER,
  ICON_VIBRATE,
} from './icons';
import { Row, SectionCard, SectionLabel, ToggleRow } from './primitives';

interface OperatorDefaultsState {
  parallelCap: number;
  thinkingEffort: string;
  defaultDispatchRuntime: OrchestratorRuntime;
  healBotEnabled: boolean;
  supervisorAutoEscalate: boolean;
}

const DISPATCH_RUNTIME_OPTIONS = listDispatchableRuntimes().map((value) => ({
  value,
  label: getRuntimeCapability(value).label,
}));

const THINKING_EFFORTS: Array<{ value: string; label: string }> = [
  { value: 'adaptive', label: 'Adaptive' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Max' },
];

export function ProfileSubView({
  hostnameLabel,
  appVersion,
  palette,
}: {
  hostnameLabel: string;
  appVersion: string;
  palette: MobilePalette;
}) {
  const versionLabel = formatAboutVersion(appVersion);
  const openRepo = useCallback(() => {
    try {
      window.open('https://github.com/hurttlocker/o8', '_blank', 'noopener,noreferrer');
    } catch {
      // ignore — desktop blockers
    }
  }, []);
  return (
    <div style={{ paddingTop: 8, paddingBottom: mobileSafeBottom(24) }}>
      <SectionLabel palette={palette}>Device</SectionLabel>
      <SectionCard palette={palette}>
        <Row
          iconPath={ICON_USER}
          label="Device name"
          rightValue={hostnameLabel}
          onClick={() => undefined}
          palette={palette}
          showChevron={false}
        />
        <Row
          iconPath={ICON_INFO}
          label="Version"
          rightValue={versionLabel}
          onClick={() => undefined}
          palette={palette}
          showChevron={false}
          showDivider={false}
        />
      </SectionCard>
      <SectionLabel palette={palette}>Source</SectionLabel>
      <SectionCard palette={palette}>
        <Row
          iconPath={ICON_GITHUB}
          label="GitHub repository"
          rightValue="hurttlocker/o8"
          onClick={openRepo}
          palette={palette}
          showDivider={false}
        />
      </SectionCard>
    </div>
  );
}

export function CapabilitiesSubView({ palette }: { palette: MobilePalette }) {
  const [defaults, setDefaults] = useState<OperatorDefaultsState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/panel/operator-defaults', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as { values?: OperatorDefaultsState };
        if (!cancelled && data.values) setDefaults(data.values);
      } catch {
        if (!cancelled) setError('Could not load operator defaults.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const update = useCallback(async (patch: Partial<OperatorDefaultsState>) => {
    if (!defaults) return;
    setSaving(true);
    setError(null);
    const next = { ...defaults, ...patch };
    setDefaults(next);
    try {
      const res = await fetch('/api/panel/operator-defaults', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { values?: OperatorDefaultsState };
      if (data.values) setDefaults(data.values);
    } catch {
      setError('Could not save change.');
    } finally {
      setSaving(false);
    }
  }, [defaults]);

  if (!defaults) {
    return (
      <div style={{ padding: 24, color: palette.subduedText, fontSize: 14, textAlign: 'center' }}>
        {error ?? 'Loading capabilities…'}
      </div>
    );
  }

  return (
    <div style={{ paddingTop: 8, paddingBottom: mobileSafeBottom(24) }}>
      <SectionLabel palette={palette}>Parallel cap</SectionLabel>
      <SectionCard palette={palette}>
        <div
          style={{
            paddingLeft: 16,
            paddingRight: 16,
            paddingTop: 16,
            paddingBottom: 16,
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
            }}
          >
            <span
              style={{
                fontSize: 15,
                fontWeight: 500,
                color: palette.rootText,
                letterSpacing: MOBILE_BODY_TRACKING,
              }}
            >
              Concurrent dispatches
            </span>
            <span
              style={{
                fontSize: 18,
                fontWeight: 700,
                color: palette.accent,
                letterSpacing: MOBILE_HEADING_TRACKING,
              }}
            >
              {defaults.parallelCap}
            </span>
          </div>
          <input
            type="range"
            min={1}
            max={16}
            step={1}
            value={defaults.parallelCap}
            onChange={(event) => {
              const next = Number.parseInt(event.target.value, 10);
              if (Number.isFinite(next)) {
                setDefaults({ ...defaults, parallelCap: next });
              }
            }}
            onMouseUp={() => void update({ parallelCap: defaults.parallelCap })}
            onTouchEnd={() => void update({ parallelCap: defaults.parallelCap })}
            disabled={saving}
            style={{
              width: '100%',
              accentColor: palette.accent,
            }}
          />
          <div
            style={{
              fontSize: 12,
              color: palette.subduedText,
              letterSpacing: MOBILE_BODY_TRACKING,
            }}
          >
            How many agents can run at once across the fleet.
          </div>
        </div>
      </SectionCard>

      <SectionLabel palette={palette}>Thinking effort</SectionLabel>
      <SectionCard palette={palette}>
        {THINKING_EFFORTS.map((effort, index) => {
          const active = defaults.thinkingEffort === effort.value;
          return (
            <Row
              key={effort.value}
              iconPath={ICON_SLIDERS}
              label={effort.label}
              rightValue={active ? 'Active' : ''}
              onClick={() => void update({ thinkingEffort: effort.value })}
              palette={palette}
              showChevron={false}
              showDivider={index < THINKING_EFFORTS.length - 1}
            />
          );
        })}
      </SectionCard>

      <SectionLabel palette={palette}>Default dispatch runtime</SectionLabel>
      <SectionCard palette={palette}>
        {DISPATCH_RUNTIME_OPTIONS.map(({ value, label }, index, options) => {
          const active = defaults.defaultDispatchRuntime === value;
          return (
            <Row
              key={value}
              iconPath={ICON_SLIDERS}
              label={label}
              rightValue={active ? 'Active' : ''}
              onClick={() => void update({ defaultDispatchRuntime: value })}
              palette={palette}
              showChevron={false}
              showDivider={index < options.length - 1}
            />
          );
        })}
      </SectionCard>

      {error ? (
        <div
          style={{
            margin: 12,
            padding: '10px 14px',
            borderRadius: MOBILE_CARD_RADIUS,
            border: `1px solid ${palette.dangerBorder}`,
            background: palette.dangerSoft,
            fontSize: 13,
            color: palette.rootText,
          }}
        >
          {error}
        </div>
      ) : null}
    </div>
  );
}

export function PermissionsSubView({ palette }: { palette: MobilePalette }) {
  const [defaults, setDefaults] = useState<OperatorDefaultsState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [haptic, setHaptic] = useState<boolean>(true);

  useEffect(() => {
    setHaptic(isHapticEnabled());
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/panel/operator-defaults', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as { values?: OperatorDefaultsState };
        if (!cancelled && data.values) setDefaults(data.values);
      } catch {
        if (!cancelled) setError('Could not load permissions.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const updateField = useCallback(async (patch: Partial<OperatorDefaultsState>) => {
    if (!defaults) return;
    const next = { ...defaults, ...patch };
    setDefaults(next);
    try {
      const res = await fetch('/api/panel/operator-defaults', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      setError('Could not save change.');
    }
  }, [defaults]);

  const updateHaptic = useCallback((next: boolean) => {
    setHaptic(next);
    setHapticEnabled(next);
    // Preview the buzz so the user feels what they just enabled.
    if (next) triggerHaptic('success');
  }, []);

  if (!defaults) {
    return (
      <div style={{ padding: 24, color: palette.subduedText, fontSize: 14, textAlign: 'center' }}>
        {error ?? 'Loading permissions…'}
      </div>
    );
  }

  return (
    <div style={{ paddingTop: 8, paddingBottom: mobileSafeBottom(24) }}>
      <SectionLabel palette={palette}>Approvals</SectionLabel>
      <SectionCard palette={palette}>
        <ToggleRow
          iconPath={ICON_SHIELD_CHECK}
          label="Auto-escalate to operator"
          value={defaults.supervisorAutoEscalate}
          onChange={(next) => void updateField({ supervisorAutoEscalate: next })}
          palette={palette}
        />
        <ToggleRow
          iconPath={ICON_SHIELD_CHECK}
          label="Heal-bot enabled"
          value={defaults.healBotEnabled}
          onChange={(next) => void updateField({ healBotEnabled: next })}
          palette={palette}
          showDivider={false}
        />
      </SectionCard>
      <SectionLabel palette={palette}>Feedback</SectionLabel>
      <SectionCard palette={palette}>
        <ToggleRow
          iconPath={ICON_VIBRATE}
          label="Haptic feedback"
          value={haptic}
          onChange={updateHaptic}
          palette={palette}
          showDivider={false}
        />
      </SectionCard>
      {error ? (
        <div
          style={{
            margin: 12,
            padding: '10px 14px',
            borderRadius: MOBILE_CARD_RADIUS,
            border: `1px solid ${palette.dangerBorder}`,
            background: palette.dangerSoft,
            fontSize: 13,
            color: palette.rootText,
          }}
        >
          {error}
        </div>
      ) : null}
    </div>
  );
}

export function AppearanceSubView({
  themeId,
  onThemeChange,
  palette,
}: {
  themeId: string;
  onThemeChange: (theme: 'light' | 'dark') => void;
  palette: MobilePalette;
}) {
  return (
    <div style={{ paddingTop: 8, paddingBottom: mobileSafeBottom(24) }}>
      <SectionLabel palette={palette}>Theme</SectionLabel>
      <SectionCard palette={palette}>
        <Row
          iconPath={ICON_PALETTE}
          label="Light"
          rightValue={themeId === 'light' ? 'Active' : ''}
          onClick={() => onThemeChange('light')}
          palette={palette}
          showChevron={false}
        />
        <Row
          iconPath={ICON_PALETTE}
          label="Dark"
          rightValue={themeId !== 'light' ? 'Active' : ''}
          onClick={() => onThemeChange('dark')}
          palette={palette}
          showChevron={false}
          showDivider={false}
        />
      </SectionCard>
    </div>
  );
}

export function ConnectorsSubView({ palette }: { palette: MobilePalette }) {
  return (
    <div style={{ paddingTop: 8, paddingBottom: mobileSafeBottom(24) }}>
      <SectionLabel palette={palette}>Connectors</SectionLabel>
      <SectionCard palette={palette}>
        <div
          style={{
            paddingTop: 18,
            paddingBottom: 18,
            paddingLeft: 16,
            paddingRight: 16,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div
            style={{
              fontSize: 15,
              fontWeight: 700,
              color: palette.rootText,
              letterSpacing: MOBILE_BODY_TRACKING,
            }}
          >
            Coming soon
          </div>
          <div
            style={{
              fontSize: 13,
              color: palette.subduedText,
              lineHeight: 1.6,
              letterSpacing: MOBILE_BODY_TRACKING,
            }}
          >
            MCP server management lives on desktop today. A read-only mobile view is on the way.
          </div>
        </div>
      </SectionCard>
    </div>
  );
}

export function PrivacySubView({ palette }: { palette: MobilePalette }) {
  const [confirming, setConfirming] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const performReset = useCallback(async () => {
    setResetting(true);
    setResult(null);
    try {
      const res = await fetch('/api/panel/factory-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: 'RESET' }),
      });
      const payload = await res.json().catch(() => ({})) as { ok?: boolean; error?: string };
      if (res.ok && payload.ok) {
        setResult('Reset complete. Restart the app to finish.');
      } else {
        setResult(payload.error ?? 'Reset failed.');
      }
    } catch {
      setResult('Reset failed — could not reach server.');
    } finally {
      setResetting(false);
      setConfirming(false);
    }
  }, []);

  return (
    <div style={{ paddingTop: 8, paddingBottom: mobileSafeBottom(24) }}>
      <SectionLabel palette={palette}>Local data</SectionLabel>
      <SectionCard palette={palette}>
        <div
          style={{
            paddingTop: 16,
            paddingBottom: 16,
            paddingLeft: 16,
            paddingRight: 16,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div
            style={{
              fontSize: 14,
              color: palette.subduedText,
              lineHeight: 1.6,
              letterSpacing: MOBILE_BODY_TRACKING,
            }}
          >
            All data lives in the o8 data directory on this machine. Nothing leaves the device unless you explicitly send it.
          </div>
        </div>
      </SectionCard>

      <SectionLabel palette={palette}>Factory reset</SectionLabel>
      <SectionCard palette={palette}>
        {!confirming ? (
          <Row
            iconPath={ICON_RESET}
            label="Reset to factory defaults"
            rightValue=""
            onClick={() => setConfirming(true)}
            palette={palette}
            showChevron={false}
            showDivider={false}
          />
        ) : (
          <div
            style={{
              paddingTop: 16,
              paddingBottom: 16,
              paddingLeft: 16,
              paddingRight: 16,
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
            }}
          >
            <div
              style={{
                fontSize: 14,
                color: palette.rootText,
                fontWeight: 600,
                letterSpacing: MOBILE_BODY_TRACKING,
              }}
            >
              This wipes sessions, mission state, encrypted API keys, and registered repos. Cannot be undone.
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={resetting}
                style={{
                  flex: 1,
                  minHeight: MOBILE_TOUCH_TARGET,
                  borderRadius: MOBILE_CARD_RADIUS,
                  border: `1px solid ${palette.cardBorder}`,
                  background: palette.panelBackground,
                  color: palette.rootText,
                  fontSize: 14,
                  fontWeight: 700,
                  letterSpacing: MOBILE_BODY_TRACKING,
                  fontFamily: mobileFontFamily(),
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void performReset()}
                disabled={resetting}
                style={{
                  flex: 1,
                  minHeight: MOBILE_TOUCH_TARGET,
                  borderRadius: MOBILE_CARD_RADIUS,
                  border: `1px solid ${palette.dangerBorder}`,
                  background: palette.dangerSoft,
                  color: palette.danger,
                  fontSize: 14,
                  fontWeight: 700,
                  letterSpacing: MOBILE_BODY_TRACKING,
                  fontFamily: mobileFontFamily(),
                  cursor: 'pointer',
                }}
              >
                {resetting ? 'Resetting…' : 'Reset'}
              </button>
            </div>
          </div>
        )}
      </SectionCard>

      {result ? (
        <div
          style={{
            margin: 12,
            padding: '12px 16px',
            borderRadius: MOBILE_CARD_RADIUS,
            border: `1px solid ${palette.cardBorder}`,
            background: palette.panelElevated,
            fontSize: 13,
            color: palette.rootText,
            lineHeight: 1.6,
            letterSpacing: MOBILE_BODY_TRACKING,
          }}
        >
          {result}
        </div>
      ) : null}
    </div>
  );
}

export function UsageSubView({ palette }: { palette: MobilePalette }) {
  return (
    <div style={{ paddingTop: 8, paddingBottom: mobileSafeBottom(24) }}>
      <SectionLabel palette={palette}>Usage</SectionLabel>
      <SectionCard palette={palette}>
        <div
          style={{
            paddingTop: 18,
            paddingBottom: 18,
            paddingLeft: 16,
            paddingRight: 16,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div
            style={{
              fontSize: 15,
              fontWeight: 700,
              color: palette.rootText,
              letterSpacing: MOBILE_BODY_TRACKING,
            }}
          >
            Open the Costs tab
          </div>
          <div
            style={{
              fontSize: 13,
              color: palette.subduedText,
              lineHeight: 1.6,
              letterSpacing: MOBILE_BODY_TRACKING,
            }}
          >
            The full token-usage dashboard lives in the dedicated Costs view from the main menu — close this sheet and tap Costs.
          </div>
        </div>
      </SectionCard>
    </div>
  );
}
