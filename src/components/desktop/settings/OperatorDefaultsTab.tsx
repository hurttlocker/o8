'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  APP_FONT_STACK,
  ActivityIcon,
  BrainIcon,
  PlugIcon,
  THEME_ACCENT,
  THEME_ACCENT_BORDER,
  THEME_ACCENT_SOFT,
} from './shared';

type OverlapGateMode = 'advisory' | 'strict';
type ThinkingEffort = 'adaptive' | 'low' | 'medium' | 'high' | 'max' | 'xhigh';
type SettingSource = 'env' | 'file' | 'default';

interface OperatorDefaults {
  parallelCap: number;
  overlapGate: OverlapGateMode;
  healBotEnabled: boolean;
  supervisorAutoEscalate: boolean;
  thinkingEffort: ThinkingEffort;
  promptCachingEnabled: boolean;
  orchestratorModel: string;
}

interface OperatorDefaultsResponse {
  values: OperatorDefaults;
  sources: Record<keyof OperatorDefaults, SettingSource>;
}

const PARALLEL_CAP_PRESETS: Array<{ key: string; label: string; value: number; sublabel: string }> = [
  { key: 'conservative', label: 'Conservative', value: 2, sublabel: '2 in flight' },
  { key: 'balanced', label: 'Balanced', value: 5, sublabel: '5 in flight' },
  { key: 'power-user', label: 'Power-user', value: 8, sublabel: '8 in flight' },
];

const THINKING_EFFORT_OPTIONS: Array<{ value: ThinkingEffort; label: string; detail: string }> = [
  { value: 'adaptive', label: 'Adaptive', detail: 'Let the model choose.' },
  { value: 'low', label: 'Low', detail: 'Quick answers.' },
  { value: 'medium', label: 'Medium', detail: 'Balanced cost and quality.' },
  { value: 'high', label: 'High', detail: 'Deeper reasoning, more tokens.' },
  { value: 'max', label: 'Max', detail: 'Highest effort allowed.' },
  { value: 'xhigh', label: 'Extended', detail: 'Extended thinking budget.' },
];

const ORCHESTRATOR_MODEL_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'claude-opus-4-7', label: 'Opus 4.7' },
  { value: 'claude-opus-4-6', label: 'Opus 4.6' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { value: 'claude-sonnet-4-5', label: 'Sonnet 4.5' },
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5' },
];

function sourceLabel(source: SettingSource): string {
  if (source === 'env') return 'Env override';
  if (source === 'file') return 'Saved';
  return 'Default';
}

function sourceBadgeStyle(source: SettingSource): React.CSSProperties {
  const base: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    borderRadius: 999,
    paddingTop: 3,
    paddingRight: 9,
    paddingBottom: 3,
    paddingLeft: 9,
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    fontFamily: APP_FONT_STACK,
  };
  if (source === 'env') {
    return {
      ...base,
      border: '1px solid rgba(245, 158, 11, 0.28)',
      background: 'rgba(245, 158, 11, 0.14)',
      color: '#b45309',
    };
  }
  if (source === 'file') {
    return {
      ...base,
      border: `1px solid ${THEME_ACCENT_BORDER}`,
      background: THEME_ACCENT_SOFT,
      color: THEME_ACCENT,
    };
  }
  return {
    ...base,
    border: '1px solid var(--t-panel-border)',
    background: 'var(--t-bg-card)',
    color: 'var(--t-text-muted)',
  };
}

// ── Small primitives ──

function SectionCard({ children, icon, title, subtitle }: {
  children: React.ReactNode;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
}) {
  return (
    <div style={{
      border: '1px solid var(--t-panel-border)',
      borderRadius: 20,
      background: 'var(--t-panel)',
      paddingTop: 18,
      paddingRight: 18,
      paddingBottom: 18,
      paddingLeft: 18,
      display: 'flex',
      flexDirection: 'column',
      gap: 14,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{
          width: 42,
          height: 42,
          borderRadius: 14,
          background: 'var(--t-bg-card)',
          border: '1px solid var(--t-panel-border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--t-text-secondary)',
          flexShrink: 0,
        }}>
          {icon}
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--t-text)', letterSpacing: '-0.02em', marginBottom: 4 }}>
            {title}
          </div>
          <div style={{ fontSize: 12, color: 'var(--t-text-secondary)', lineHeight: 1.5 }}>
            {subtitle}
          </div>
        </div>
      </div>
      {children}
    </div>
  );
}

function Row({ label, description, source, right, disabledReason }: {
  label: string;
  description: string;
  source: SettingSource;
  right: React.ReactNode;
  disabledReason?: string | null;
}) {
  return (
    <div
      style={{
        border: '1px solid var(--t-panel-border)',
        borderRadius: 16,
        background: 'var(--t-bg-card)',
        paddingTop: 14,
        paddingRight: 14,
        paddingBottom: 14,
        paddingLeft: 14,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 14,
        flexWrap: 'wrap',
      }}
      title={disabledReason ?? undefined}
    >
      <div style={{ minWidth: 0, flex: '1 1 260px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--t-text)' }}>{label}</span>
          <span style={sourceBadgeStyle(source)}>{sourceLabel(source)}</span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--t-text-secondary)', lineHeight: 1.5 }}>
          {description}
          {disabledReason ? (
            <div style={{ marginTop: 4, color: 'var(--t-text-muted)', fontSize: 11 }}>
              {disabledReason}
            </div>
          ) : null}
        </div>
      </div>
      <div style={{ flexShrink: 0 }}>
        {right}
      </div>
    </div>
  );
}

function ToggleSwitch({ checked, onChange, disabled }: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label style={{
      position: 'relative',
      display: 'inline-flex',
      alignItems: 'center',
      width: 48,
      height: 28,
      flexShrink: 0,
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.6 : 1,
    }}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        style={{ position: 'absolute', inset: 0, opacity: 0, cursor: disabled ? 'not-allowed' : 'pointer' }}
      />
      <span style={{
        position: 'absolute',
        inset: 0,
        borderRadius: 999,
        background: checked ? THEME_ACCENT : 'var(--t-input-bg)',
        border: checked ? `1px solid ${THEME_ACCENT}` : '1px solid var(--t-panel-border)',
        transition: 'background 150ms ease, border-color 150ms ease',
      }} />
      <span style={{
        position: 'absolute',
        top: 3,
        left: checked ? 23 : 3,
        width: 20,
        height: 20,
        borderRadius: 999,
        background: '#ffffff',
        boxShadow: '0 2px 6px rgba(15, 23, 42, 0.18)',
        transition: 'left 180ms ease',
      }} />
    </label>
  );
}

function SegmentedControl<T extends string>({ value, options, onChange, disabled }: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (next: T) => void;
  disabled?: boolean;
}) {
  return (
    <div style={{
      display: 'inline-flex',
      border: '1px solid var(--t-panel-border)',
      borderRadius: 12,
      background: 'var(--t-input-bg)',
      padding: 3,
      gap: 2,
    }}>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            disabled={disabled}
            onClick={() => onChange(opt.value)}
            style={{
              minHeight: 30,
              paddingTop: 0,
              paddingRight: 12,
              paddingBottom: 0,
              paddingLeft: 12,
              borderRadius: 9,
              border: '1px solid transparent',
              background: active ? THEME_ACCENT : 'transparent',
              color: active ? '#ffffff' : 'var(--t-text-secondary)',
              fontSize: 12,
              fontWeight: 600,
              cursor: disabled ? 'not-allowed' : 'pointer',
              fontFamily: APP_FONT_STACK,
              transition: 'background 120ms ease, color 120ms ease',
              opacity: disabled ? 0.6 : 1,
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function PickerMenu<T extends string>({ value, options, onChange, disabled, minWidth }: {
  value: T;
  options: Array<{ value: T; label: string; detail?: string }>;
  onChange: (next: T) => void;
  disabled?: boolean;
  minWidth?: number;
}) {
  const [open, setOpen] = useState(false);
  const active = options.find((opt) => opt.value === value);
  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => { if (!disabled) setOpen((o) => !o); }}
        onBlur={() => { window.setTimeout(() => setOpen(false), 120); }}
        style={{
          minHeight: 36,
          minWidth: minWidth ?? 160,
          paddingTop: 0,
          paddingRight: 12,
          paddingBottom: 0,
          paddingLeft: 12,
          border: '1px solid var(--t-panel-border)',
          borderRadius: 12,
          background: 'var(--t-input-bg)',
          color: 'var(--t-text)',
          fontSize: 13,
          fontWeight: 600,
          textAlign: 'left',
          cursor: disabled ? 'not-allowed' : 'pointer',
          fontFamily: APP_FONT_STACK,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          opacity: disabled ? 0.6 : 1,
        }}
      >
        <span>{active?.label ?? value}</span>
        <svg
          width={12}
          height={12}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          style={{ flexShrink: 0, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 180ms ease' }}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && !disabled ? (
        <div
          onMouseDown={(event) => event.preventDefault()}
          style={{
            position: 'absolute',
            top: '110%',
            right: 0,
            minWidth: minWidth ?? 220,
            border: '1px solid var(--t-panel-border)',
            borderRadius: 12,
            background: 'var(--t-panel)',
            boxShadow: '0 16px 48px rgba(15, 23, 42, 0.22)',
            zIndex: 20,
            padding: 4,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            maxHeight: 280,
            overflowY: 'auto',
          }}
        >
          {options.map((opt) => {
            const active = opt.value === value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => { onChange(opt.value); setOpen(false); }}
                style={{
                  width: '100%',
                  minHeight: 34,
                  paddingTop: 6,
                  paddingRight: 10,
                  paddingBottom: 6,
                  paddingLeft: 10,
                  border: active ? `1px solid ${THEME_ACCENT_BORDER}` : '1px solid transparent',
                  borderRadius: 9,
                  background: active ? THEME_ACCENT_SOFT : 'transparent',
                  color: active ? THEME_ACCENT : 'var(--t-text)',
                  fontSize: 13,
                  fontWeight: active ? 700 : 500,
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontFamily: APP_FONT_STACK,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                }}
              >
                <span>{opt.label}</span>
                {opt.detail ? (
                  <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--t-text-muted)' }}>{opt.detail}</span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

// ── Main tab ──

export function OperatorDefaultsTab() {
  const [data, setData] = useState<OperatorDefaultsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyField, setBusyField] = useState<keyof OperatorDefaults | null>(null);
  const [capDraft, setCapDraft] = useState<string>('');

  const loadDefaults = useCallback(async () => {
    try {
      const response = await fetch('/api/panel/operator-defaults', { cache: 'no-store' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof payload.error === 'string' ? payload.error : 'Failed to load operator defaults.');
      }
      setData(payload as OperatorDefaultsResponse);
      setNotice(null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Failed to load operator defaults.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDefaults();
  }, [loadDefaults]);

  useEffect(() => {
    if (data) {
      setCapDraft(String(data.values.parallelCap));
    }
  }, [data]);

  const updateField = useCallback(async <K extends keyof OperatorDefaults>(field: K, value: OperatorDefaults[K]) => {
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
  }, []);

  const values = data?.values;
  const sources = data?.sources;

  const parallelCapEnv = sources?.parallelCap === 'env';
  const overlapGateEnv = sources?.overlapGate === 'env';
  const healBotEnv = sources?.healBotEnabled === 'env';
  const supervisorEnv = sources?.supervisorAutoEscalate === 'env';
  const thinkingEnv = sources?.thinkingEffort === 'env';
  const cachingEnv = sources?.promptCachingEnabled === 'env';
  const modelEnv = sources?.orchestratorModel === 'env';

  const envDisabledReason = 'Controlled by an environment variable. Unset it to manage this from Settings.';

  const commitCapDraft = useCallback(() => {
    if (!values) return;
    const parsed = Number.parseInt(capDraft, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 32) {
      setNotice('Parallel cap must be an integer between 1 and 32.');
      setCapDraft(String(values.parallelCap));
      return;
    }
    if (parsed === values.parallelCap) return;
    void updateField('parallelCap', parsed);
  }, [capDraft, updateField, values]);

  const activePresetKey = useMemo(() => {
    if (!values) return null;
    const match = PARALLEL_CAP_PRESETS.find((preset) => preset.value === values.parallelCap);
    return match?.key ?? null;
  }, [values]);

  if (loading && !data) {
    return (
      <div style={{
        paddingTop: 32,
        paddingRight: 32,
        paddingBottom: 32,
        paddingLeft: 32,
        color: 'var(--t-text-muted)',
        fontSize: 13,
        fontFamily: APP_FONT_STACK,
      }}>
        Loading operator defaults...
      </div>
    );
  }

  if (!values || !sources) {
    return (
      <div style={{
        paddingTop: 32,
        paddingRight: 32,
        paddingBottom: 32,
        paddingLeft: 32,
        color: '#b91c1c',
        fontSize: 13,
        fontFamily: APP_FONT_STACK,
      }}>
        {notice ?? 'Unable to load operator defaults.'}
      </div>
    );
  }

  return (
    <div style={{
      paddingTop: 32,
      paddingRight: 32,
      paddingBottom: 32,
      paddingLeft: 32,
      maxWidth: 860,
      fontFamily: APP_FONT_STACK,
    }}>
      <div style={{
        fontSize: 28,
        fontWeight: 800,
        color: 'var(--t-text)',
        marginBottom: 6,
        letterSpacing: '-0.05em',
        lineHeight: 1,
      }}>
        Dispatch &amp; Supervision
      </div>
      <div style={{
        fontSize: 14,
        color: 'var(--t-text-secondary)',
        marginBottom: 22,
        lineHeight: 1.5,
        maxWidth: 720,
      }}>
        Operator defaults applied across the whole fleet. Environment variables still win — everything here is the
        persisted fallback for when no env var is set.
      </div>

      {notice ? (
        <div style={{
          marginBottom: 14,
          border: '1px solid rgba(239, 68, 68, 0.16)',
          borderRadius: 14,
          background: 'rgba(239, 68, 68, 0.08)',
          color: '#b91c1c',
          fontSize: 13,
          fontWeight: 600,
          paddingTop: 12,
          paddingRight: 14,
          paddingBottom: 12,
          paddingLeft: 14,
        }}>
          {notice}
        </div>
      ) : null}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <SectionCard
          icon={<ActivityIcon />}
          title="Parallel dispatch cap"
          subtitle="How many codex packets the orchestrator will run at once. Env var O8_MAX_PARALLEL_DISPATCHES overrides."
        >
          <Row
            label="Cap"
            description="Pick a preset or set a custom number (1-32). The next dispatch tick uses the new value."
            source={sources.parallelCap}
            disabledReason={parallelCapEnv ? envDisabledReason : undefined}
            right={
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                <div style={{ display: 'inline-flex', gap: 6 }}>
                  {PARALLEL_CAP_PRESETS.map((preset) => {
                    const active = activePresetKey === preset.key;
                    return (
                      <button
                        key={preset.key}
                        type="button"
                        disabled={parallelCapEnv || busyField === 'parallelCap'}
                        onClick={() => {
                          setCapDraft(String(preset.value));
                          void updateField('parallelCap', preset.value);
                        }}
                        style={{
                          minHeight: 36,
                          paddingTop: 6,
                          paddingRight: 12,
                          paddingBottom: 6,
                          paddingLeft: 12,
                          border: active ? `1px solid ${THEME_ACCENT}` : '1px solid var(--t-panel-border)',
                          borderRadius: 12,
                          background: active ? THEME_ACCENT_SOFT : 'var(--t-bg-card)',
                          color: active ? THEME_ACCENT : 'var(--t-text)',
                          fontSize: 12,
                          fontWeight: 700,
                          cursor: parallelCapEnv ? 'not-allowed' : 'pointer',
                          fontFamily: APP_FONT_STACK,
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          gap: 2,
                          opacity: parallelCapEnv ? 0.6 : 1,
                        }}
                      >
                        <span>{preset.label}</span>
                        <span style={{
                          fontSize: 10,
                          fontWeight: 500,
                          color: active ? THEME_ACCENT : 'var(--t-text-muted)',
                        }}>
                          {preset.sublabel}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <input
                    type="number"
                    min={1}
                    max={32}
                    disabled={parallelCapEnv || busyField === 'parallelCap'}
                    value={capDraft}
                    onChange={(event) => setCapDraft(event.target.value)}
                    onBlur={commitCapDraft}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        (event.currentTarget as HTMLInputElement).blur();
                      }
                    }}
                    style={{
                      width: 76,
                      height: 36,
                      border: '1px solid var(--t-panel-border)',
                      borderRadius: 12,
                      background: 'var(--t-input-bg)',
                      color: 'var(--t-text)',
                      fontSize: 13,
                      fontWeight: 600,
                      textAlign: 'center',
                      fontFamily: APP_FONT_STACK,
                      outline: 'none',
                      paddingTop: 0,
                      paddingRight: 8,
                      paddingBottom: 0,
                      paddingLeft: 8,
                    }}
                  />
                </div>
              </div>
            }
          />
        </SectionCard>

        <SectionCard
          icon={<PlugIcon />}
          title="Overlap gate"
          subtitle="How to handle packets that predict overlapping file changes. Env var O8_STRICT_OVERLAP_GATE overrides."
        >
          <Row
            label="Mode"
            description={values.overlapGate === 'strict'
              ? 'Strict: hold overlapping packets until the active one merges. Safer, slower.'
              : 'Advisory: dispatch everything; resolve conflicts at rebase time. Default.'}
            source={sources.overlapGate}
            disabledReason={overlapGateEnv ? envDisabledReason : undefined}
            right={
              <SegmentedControl<OverlapGateMode>
                value={values.overlapGate}
                options={[
                  { value: 'advisory', label: 'Advisory' },
                  { value: 'strict', label: 'Strict' },
                ]}
                onChange={(next) => { void updateField('overlapGate', next); }}
                disabled={overlapGateEnv || busyField === 'overlapGate'}
              />
            }
          />
        </SectionCard>

        <SectionCard
          icon={<BrainIcon />}
          title="Supervision"
          subtitle="Automated healing and escalation behaviour for packets that fail verification."
        >
          <Row
            label="Heal-bot"
            description="When on, the supervisor inbox spawns a scoped Claude Code fix attempt before asking a human."
            source={sources.healBotEnabled}
            disabledReason={healBotEnv ? envDisabledReason : undefined}
            right={
              <ToggleSwitch
                checked={values.healBotEnabled}
                disabled={healBotEnv || busyField === 'healBotEnabled'}
                onChange={(next) => { void updateField('healBotEnabled', next); }}
              />
            }
          />
          <Row
            label="Supervisor auto-escalate"
            description="Inject supervisor failures back into the orchestrator chat for auto-investigation. Off keeps chat clean."
            source={sources.supervisorAutoEscalate}
            disabledReason={supervisorEnv ? envDisabledReason : undefined}
            right={
              <ToggleSwitch
                checked={values.supervisorAutoEscalate}
                disabled={supervisorEnv || busyField === 'supervisorAutoEscalate'}
                onChange={(next) => { void updateField('supervisorAutoEscalate', next); }}
              />
            }
          />
        </SectionCard>

        <SectionCard
          icon={<BrainIcon />}
          title="Orchestrator model"
          subtitle="Default model and thinking profile for the orchestrator chat. Individual sessions can still override."
        >
          <Row
            label="Model"
            description="The default Claude model that powers the Orchestrator tab. Changes apply to new turns only."
            source={sources.orchestratorModel}
            disabledReason={modelEnv ? envDisabledReason : undefined}
            right={
              <PickerMenu<string>
                value={values.orchestratorModel}
                options={ORCHESTRATOR_MODEL_OPTIONS}
                onChange={(next) => { void updateField('orchestratorModel', next); }}
                disabled={modelEnv || busyField === 'orchestratorModel'}
                minWidth={200}
              />
            }
          />
          <Row
            label="Thinking effort"
            description="Default effort applied to orchestrator turns. Adaptive lets the model pick based on task."
            source={sources.thinkingEffort}
            disabledReason={thinkingEnv ? envDisabledReason : undefined}
            right={
              <PickerMenu<ThinkingEffort>
                value={values.thinkingEffort}
                options={THINKING_EFFORT_OPTIONS}
                onChange={(next) => { void updateField('thinkingEffort', next); }}
                disabled={thinkingEnv || busyField === 'thinkingEffort'}
                minWidth={200}
              />
            }
          />
          <Row
            label="Prompt caching"
            description="Mark the Anthropic system prompt with cache_control. Saves ~90% on repeated turns."
            source={sources.promptCachingEnabled}
            disabledReason={cachingEnv ? envDisabledReason : undefined}
            right={
              <ToggleSwitch
                checked={values.promptCachingEnabled}
                disabled={cachingEnv || busyField === 'promptCachingEnabled'}
                onChange={(next) => { void updateField('promptCachingEnabled', next); }}
              />
            }
          />
        </SectionCard>
      </div>
    </div>
  );
}
