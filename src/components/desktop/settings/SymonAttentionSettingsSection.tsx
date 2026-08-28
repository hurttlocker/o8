'use client';

import { useCallback, useEffect, useState } from 'react';

import { SettingsGroup, SettingsRow, ValuePill } from './grouped';
import { APP_FONT_STACK } from './shared';
import { fetchOperatorDefaults } from './operator-defaults-client';

interface AttentionSettings {
  broadcastVoice: 'off' | 'on';
  broadcastCommentaryMaxPerHour: number;
  broadcastVoiceLullMinutes: number;
  broadcastVoiceQuietHours: 'off' | 'on';
  broadcastVoiceQuietStart: string;
  broadcastVoiceQuietEnd: string;
  broadcastVoiceAttention: boolean;
  broadcastVoiceApprovals: boolean;
  broadcastVoiceReviews: boolean;
  broadcastVoiceFailures: boolean;
  broadcastVoiceCompletions: boolean;
  broadcastVoiceCalendar: boolean;
  broadcastVoiceCalendarLeadMinutes: number;
  broadcastVoiceTimeCheckins: boolean;
}

const FALLBACK: AttentionSettings = {
  broadcastVoice: 'off',
  broadcastCommentaryMaxPerHour: 12,
  broadcastVoiceLullMinutes: 6,
  broadcastVoiceQuietHours: 'on',
  broadcastVoiceQuietStart: '22:00',
  broadcastVoiceQuietEnd: '08:00',
  broadcastVoiceAttention: true,
  broadcastVoiceApprovals: true,
  broadcastVoiceReviews: true,
  broadcastVoiceFailures: true,
  broadcastVoiceCompletions: true,
  broadcastVoiceCalendar: true,
  broadcastVoiceCalendarLeadMinutes: 15,
  broadcastVoiceTimeCheckins: true,
};

function BellGlyph() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
      <path d="M10 21h4" />
    </svg>
  );
}

function ClockGlyph() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

const inputStyle: React.CSSProperties = {
  width: 74,
  height: 28,
  paddingLeft: 7,
  paddingRight: 7,
  fontSize: 12,
  fontFamily: APP_FONT_STACK,
  color: 'var(--t-text)',
  background: 'var(--t-input-bg)',
  border: '1px solid var(--t-divider)',
  borderRadius: 7,
  outline: 'none',
};

export function SymonAttentionSettingsSection() {
  const [settings, setSettings] = useState(FALLBACK);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<keyof AttentionSettings | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const response = await fetchOperatorDefaults({}, { fresh: true });
      const payload = await response.json() as { values?: Partial<AttentionSettings>; error?: string };
      if (!response.ok || !payload.values) throw new Error(payload.error ?? 'Attention settings could not be loaded.');
      setSettings((current) => ({ ...current, ...payload.values }));
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Attention settings could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const save = useCallback(async <K extends keyof AttentionSettings>(field: K, value: AttentionSettings[K]) => {
    const previous = settings[field];
    setSettings((current) => ({ ...current, [field]: value }));
    setSaving(field);
    setError('');
    try {
      const response = await fetchOperatorDefaults({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: value }),
      });
      const payload = await response.json() as { values?: Partial<AttentionSettings>; error?: string };
      if (!response.ok || !payload.values) throw new Error(payload.error ?? 'Attention setting could not be saved.');
      setSettings((current) => ({ ...current, ...payload.values }));
    } catch (cause) {
      setSettings((current) => ({ ...current, [field]: previous }));
      setError(cause instanceof Error ? cause.message : 'Attention setting could not be saved.');
    } finally {
      setSaving(null);
    }
  }, [settings]);

  const enabled = settings.broadcastVoice === 'on';
  const quietEnabled = settings.broadcastVoiceQuietHours === 'on';
  const disabled = loading || saving !== null;

  return (
    <section style={{ marginTop: 28 }}>
      <SettingsGroup
        header="Proactive attention"
        footnote="Read-only callouts only. Symon never performs a scheduled mutation. Every automatic line is capped, deduplicated, and written to the attention ledger with its source events."
      >
        <SettingsRow
          icon={<BellGlyph />}
          label="Spoken updates"
          subtitle="Let Symon tell you when subscribed work needs attention"
          checked={enabled}
          onToggle={(next) => { void save('broadcastVoice', next ? 'on' : 'off'); }}
          disabled={disabled}
          divider
        />
        <SettingsRow
          icon={<BellGlyph />}
          label="Hourly budget"
          subtitle="Maximum automatic commentary and spoken updates in any rolling hour"
          accessory={
            <input
              aria-label="Maximum spoken updates per hour"
              type="number"
              min={1}
              max={60}
              value={settings.broadcastCommentaryMaxPerHour}
              disabled={disabled}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (Number.isSafeInteger(value) && value >= 1 && value <= 60) {
                  void save('broadcastCommentaryMaxPerHour', value);
                }
              }}
              style={inputStyle}
            />
          }
          divider
        />
        <SettingsRow
          icon={<ClockGlyph />}
          label="Quiet hours"
          subtitle="Automatic callouts stay silent; a line you explicitly request can still play"
          checked={quietEnabled}
          onToggle={(next) => { void save('broadcastVoiceQuietHours', next ? 'on' : 'off'); }}
          disabled={disabled}
          divider
        />
        <SettingsRow
          icon={<ClockGlyph />}
          label="Quiet window"
          subtitle="Uses this Mac's local time and may cross midnight"
          accessory={
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <input
                aria-label="Quiet hours start"
                type="time"
                value={settings.broadcastVoiceQuietStart}
                disabled={disabled || !quietEnabled}
                onChange={(event) => { void save('broadcastVoiceQuietStart', event.target.value); }}
                style={inputStyle}
              />
              <span style={{ color: 'var(--t-text-faint)', fontSize: 11 }}>to</span>
              <input
                aria-label="Quiet hours end"
                type="time"
                value={settings.broadcastVoiceQuietEnd}
                disabled={disabled || !quietEnabled}
                onChange={(event) => { void save('broadcastVoiceQuietEnd', event.target.value); }}
                style={inputStyle}
              />
            </span>
          }
          divider
        />
        <SettingsRow
          label="Work needs you"
          subtitle="A current lane is waiting for operator input"
          checked={settings.broadcastVoiceAttention}
          onToggle={(next) => { void save('broadcastVoiceAttention', next); }}
          disabled={disabled || !enabled}
          divider
        />
        <SettingsRow
          label="Approvals"
          subtitle="A new approval is still pending when Symon is ready to speak"
          checked={settings.broadcastVoiceApprovals}
          onToggle={(next) => { void save('broadcastVoiceApprovals', next); }}
          disabled={disabled || !enabled}
          divider
        />
        <SettingsRow
          label="Review verdicts"
          subtitle="Review approved the packet or requested changes"
          checked={settings.broadcastVoiceReviews}
          onToggle={(next) => { void save('broadcastVoiceReviews', next); }}
          disabled={disabled || !enabled}
          divider
        />
        <SettingsRow
          label="Failures and limits"
          subtitle="A packet failed, hit a spend cap, or timed out on a lease"
          checked={settings.broadcastVoiceFailures}
          onToggle={(next) => { void save('broadcastVoiceFailures', next); }}
          disabled={disabled || !enabled}
          divider
        />
        <SettingsRow
          label="Completed work"
          subtitle="A packet completed or merged"
          checked={settings.broadcastVoiceCompletions}
          onToggle={(next) => { void save('broadcastVoiceCompletions', next); }}
          disabled={disabled || !enabled}
          divider
        />
        <SettingsRow
          label="Calendar events"
          subtitle="An upcoming timed event is still in the future when Symon is ready to speak"
          checked={settings.broadcastVoiceCalendar}
          onToggle={(next) => { void save('broadcastVoiceCalendar', next); }}
          disabled={disabled || !enabled}
          divider
        />
        <SettingsRow
          icon={<ClockGlyph />}
          label="Calendar lead time"
          subtitle="Minutes before a timed event becomes eligible for one deduplicated callout"
          accessory={
            <input
              aria-label="Calendar alert lead time in minutes"
              type="number"
              min={1}
              max={1_440}
              value={settings.broadcastVoiceCalendarLeadMinutes}
              disabled={disabled || !enabled || !settings.broadcastVoiceCalendar}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (Number.isSafeInteger(value) && value >= 1 && value <= 1_440) {
                  void save('broadcastVoiceCalendarLeadMinutes', value);
                }
              }}
              style={inputStyle}
            />
          }
          divider
        />
        <SettingsRow
          label="Time check-ins"
          subtitle={`After ${settings.broadcastVoiceLullMinutes} quiet minutes, summarize the active focus once; use Automations for scheduled summaries`}
          checked={settings.broadcastVoiceTimeCheckins}
          onToggle={(next) => { void save('broadcastVoiceTimeCheckins', next); }}
          disabled={disabled || !enabled}
        />
      </SettingsGroup>
      {error ? (
        <div role="alert" style={{ marginTop: 8, maxWidth: 620, color: 'var(--t-danger, #d94f3a)', fontSize: 12, lineHeight: 1.45 }}>
          {error}
        </div>
      ) : loading ? (
        <div style={{ marginTop: 8 }}><ValuePill>Loading attention policy…</ValuePill></div>
      ) : null}
    </section>
  );
}
