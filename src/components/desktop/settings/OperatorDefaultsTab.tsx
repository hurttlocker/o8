'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  APP_FONT_STACK,
  MONO_FONT_STACK,
  RAMS_ACCENT,
  RAMS_HAIRLINE_SOFT,
  RAMS_INK_QUIET,
  BracketLabel,
  HairlineRule,
  SectionLabel,
  TabBreadcrumb,
  TabHeading,
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
  if (source === 'env') return 'env override';
  if (source === 'file') return 'saved';
  return 'default';
}

// ── Small primitives ──

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
        paddingTop: 14,
        paddingBottom: 14,
        paddingLeft: 2,
        paddingRight: 2,
        borderBottom: `1px solid ${RAMS_HAIRLINE_SOFT}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 20,
        flexWrap: 'wrap',
      }}
      title={disabledReason ?? undefined}
    >
      <div style={{ minWidth: 0, flex: '1 1 320px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{
            fontSize: 14,
            fontWeight: 500,
            color: 'var(--t-text)',
            letterSpacing: '-0.01em',
          }}>
            {label}
          </span>
          <BracketLabel tone="quiet">{sourceLabel(source)}</BracketLabel>
        </div>
        <div style={{ fontSize: 12, color: 'var(--t-text-secondary)', lineHeight: 1.55 }}>
          {description}
          {disabledReason ? (
            <div style={{ marginTop: 4, color: RAMS_INK_QUIET, fontSize: 11 }}>
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

function ToggleLink({ checked, onChange, disabled }: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => { if (!disabled) onChange(!checked); }}
      disabled={disabled}
      style={{
        fontFamily: MONO_FONT_STACK,
        fontSize: 11,
        fontWeight: 400,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        color: checked ? RAMS_ACCENT : 'var(--t-text-muted)',
        background: 'transparent',
        border: 'none',
        borderBottom: `1px solid ${checked ? RAMS_ACCENT : RAMS_HAIRLINE_SOFT}`,
        paddingTop: 3,
        paddingBottom: 3,
        paddingLeft: 0,
        paddingRight: 0,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
      }}
      aria-pressed={checked}
    >
      {checked ? '(on)' : '(off)'}
    </button>
  );
}

function SegmentedControl<T extends string>({ value, options, onChange, disabled }: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (next: T) => void;
  disabled?: boolean;
}) {
  return (
    <div style={{ display: 'inline-flex', gap: 20, alignItems: 'center' }}>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            disabled={disabled}
            onClick={() => onChange(opt.value)}
            style={{
              fontFamily: MONO_FONT_STACK,
              fontSize: 11,
              fontWeight: 400,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: active ? RAMS_ACCENT : 'var(--t-text-muted)',
              background: 'transparent',
              border: 'none',
              borderBottom: `1px solid ${active ? RAMS_ACCENT : RAMS_HAIRLINE_SOFT}`,
              paddingTop: 3,
              paddingBottom: 3,
              paddingLeft: 0,
              paddingRight: 0,
              cursor: disabled ? 'not-allowed' : 'pointer',
              opacity: disabled ? 0.6 : 1,
            }}
          >
            ({opt.label.toLowerCase()})
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
          minWidth: minWidth ?? 140,
          paddingTop: 4,
          paddingBottom: 4,
          paddingLeft: 0,
          paddingRight: 0,
          border: 'none',
          borderBottom: `1px solid ${RAMS_HAIRLINE_SOFT}`,
          background: 'transparent',
          color: 'var(--t-text)',
          fontSize: 13,
          fontWeight: 400,
          textAlign: 'left',
          cursor: disabled ? 'not-allowed' : 'pointer',
          fontFamily: APP_FONT_STACK,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          opacity: disabled ? 0.6 : 1,
          letterSpacing: '-0.005em',
        }}
      >
        <span>{active?.label ?? value}</span>
        <svg
          width={11}
          height={11}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          style={{ flexShrink: 0, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 160ms ease', color: RAMS_INK_QUIET }}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && !disabled ? (
        <div
          onMouseDown={(event) => event.preventDefault()}
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            minWidth: minWidth ?? 220,
            border: `1px solid ${RAMS_HAIRLINE_SOFT}`,
            borderRadius: 4,
            background: 'var(--t-panel)',
            zIndex: 20,
            paddingTop: 4,
            paddingBottom: 4,
            paddingLeft: 0,
            paddingRight: 0,
            display: 'flex',
            flexDirection: 'column',
            maxHeight: 280,
            overflowY: 'auto',
          }}
        >
          {options.map((opt) => {
            const isActive = opt.value === value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => { onChange(opt.value); setOpen(false); }}
                style={{
                  paddingTop: 8,
                  paddingBottom: 8,
                  paddingLeft: 12,
                  paddingRight: 12,
                  border: 'none',
                  borderLeft: isActive ? `2px solid ${RAMS_ACCENT}` : '2px solid transparent',
                  background: 'transparent',
                  color: 'var(--t-text)',
                  fontSize: 13,
                  fontWeight: isActive ? 500 : 400,
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontFamily: APP_FONT_STACK,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                  letterSpacing: '-0.005em',
                }}
              >
                <span>{opt.label}</span>
                {opt.detail ? (
                  <span style={{
                    fontSize: 11,
                    fontWeight: 400,
                    color: RAMS_INK_QUIET,
                    fontFamily: APP_FONT_STACK,
                  }}>
                    {opt.detail}
                  </span>
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

  const envDisabledReason = 'Controlled by environment variable. Unset to manage from Settings.';

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
        paddingTop: 40,
        color: 'var(--t-text-muted)',
        fontSize: 13,
        fontFamily: APP_FONT_STACK,
      }}>
        Loading dispatch settings...
      </div>
    );
  }

  if (!values || !sources) {
    return (
      <div style={{
        paddingTop: 40,
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
      paddingTop: 8,
      paddingLeft: 8,
      paddingRight: 32,
      paddingBottom: 40,
      maxWidth: 780,
      fontFamily: APP_FONT_STACK,
    }}>
      <TabBreadcrumb tab="dispatch" />
      <TabHeading
        title="dispatch & supervision"
        subtitle="Operator defaults applied across the fleet. Environment variables still win — everything here is the persisted fallback when no env var is set."
      />

      {notice ? (
        <div style={{
          marginBottom: 28,
          borderLeft: `2px solid #ef4444`,
          paddingLeft: 14,
          paddingTop: 2,
          paddingBottom: 2,
          fontSize: 13,
          color: 'var(--t-text)',
          lineHeight: 1.55,
        }}>
          {notice}
        </div>
      ) : null}

      {/* 01 — PARALLEL CAP */}
      <section style={{ marginBottom: 32 }}>
        <SectionLabel number="01">PARALLEL CAP</SectionLabel>
        <p style={{
          fontSize: 13,
          color: 'var(--t-text-secondary)',
          lineHeight: 1.55,
          maxWidth: 580,
          margin: 0,
          marginBottom: 12,
        }}>
          How many codex packets the orchestrator runs at once. Env var{' '}
          <span style={{ fontFamily: MONO_FONT_STACK, fontSize: 12, color: 'var(--t-text-secondary)' }}>O8_MAX_PARALLEL_DISPATCHES</span>
          {' '}overrides.
        </p>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
          borderTop: `1px solid ${RAMS_HAIRLINE_SOFT}`,
          borderBottom: `1px solid ${RAMS_HAIRLINE_SOFT}`,
        }}>
          {PARALLEL_CAP_PRESETS.map((preset, idx) => {
            const active = activePresetKey === preset.key;
            const isLast = idx === PARALLEL_CAP_PRESETS.length - 1;
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
                  paddingTop: 16,
                  paddingBottom: 16,
                  paddingLeft: 14,
                  paddingRight: 14,
                  border: 'none',
                  borderRight: isLast ? 'none' : `1px solid ${RAMS_HAIRLINE_SOFT}`,
                  borderLeft: active ? `2px solid ${RAMS_ACCENT}` : '2px solid transparent',
                  background: 'transparent',
                  color: 'var(--t-text)',
                  cursor: parallelCapEnv ? 'not-allowed' : 'pointer',
                  fontFamily: APP_FONT_STACK,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  textAlign: 'left',
                  opacity: parallelCapEnv ? 0.55 : 1,
                }}
              >
                <span style={{
                  fontSize: 14,
                  fontWeight: 500,
                  color: active ? RAMS_ACCENT : 'var(--t-text)',
                  letterSpacing: '-0.01em',
                }}>
                  {preset.label.toLowerCase()}
                </span>
                <span style={{
                  fontSize: 12,
                  fontWeight: 400,
                  color: RAMS_INK_QUIET,
                  fontFamily: MONO_FONT_STACK,
                  letterSpacing: '0.04em',
                }}>
                  {preset.sublabel}
                </span>
              </button>
            );
          })}
        </div>

        <div style={{
          marginTop: 16,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
        }}>
          <span style={{
            fontFamily: MONO_FONT_STACK,
            fontSize: 10,
            letterSpacing: '0.18em',
            color: RAMS_INK_QUIET,
            textTransform: 'uppercase',
          }}>
            custom
          </span>
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
              width: 80,
              border: 'none',
              borderBottom: `1px solid ${RAMS_HAIRLINE_SOFT}`,
              background: 'transparent',
              color: 'var(--t-text)',
              fontSize: 14,
              fontWeight: 400,
              textAlign: 'left',
              fontFamily: MONO_FONT_STACK,
              outline: 'none',
              paddingTop: 4,
              paddingBottom: 4,
              paddingLeft: 0,
              paddingRight: 0,
              letterSpacing: '0.04em',
            }}
          />
          <span style={{ fontSize: 12, color: RAMS_INK_QUIET }}>1 – 32</span>
        </div>
      </section>

      {/* 02 — OVERLAP GATE */}
      <section style={{ marginBottom: 32 }}>
        <SectionLabel number="02">OVERLAP GATE</SectionLabel>
        <p style={{
          fontSize: 13,
          color: 'var(--t-text-secondary)',
          lineHeight: 1.55,
          maxWidth: 580,
          margin: 0,
          marginBottom: 4,
        }}>
          How to handle packets that predict overlapping file changes. Env var{' '}
          <span style={{ fontFamily: MONO_FONT_STACK, fontSize: 12, color: 'var(--t-text-secondary)' }}>O8_STRICT_OVERLAP_GATE</span>
          {' '}overrides.
        </p>

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
      </section>

      {/* 03 — THINKING EFFORT (includes supervision toggles) */}
      <section style={{ marginBottom: 32 }}>
        <SectionLabel number="03">SUPERVISION</SectionLabel>
        <p style={{
          fontSize: 13,
          color: 'var(--t-text-secondary)',
          lineHeight: 1.55,
          maxWidth: 580,
          margin: 0,
          marginBottom: 4,
        }}>
          Automated healing and escalation for packets that fail verification.
        </p>

        <Row
          label="Heal-bot"
          description="When on, the supervisor inbox spawns a scoped Claude Code fix attempt before asking a human."
          source={sources.healBotEnabled}
          disabledReason={healBotEnv ? envDisabledReason : undefined}
          right={
            <ToggleLink
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
            <ToggleLink
              checked={values.supervisorAutoEscalate}
              disabled={supervisorEnv || busyField === 'supervisorAutoEscalate'}
              onChange={(next) => { void updateField('supervisorAutoEscalate', next); }}
            />
          }
        />
      </section>

      {/* 04 — ORCHESTRATOR MODEL */}
      <section style={{ marginBottom: 32 }}>
        <SectionLabel number="04">ORCHESTRATOR MODEL</SectionLabel>
        <p style={{
          fontSize: 13,
          color: 'var(--t-text-secondary)',
          lineHeight: 1.55,
          maxWidth: 580,
          margin: 0,
          marginBottom: 4,
        }}>
          Default model and thinking profile for the orchestrator chat. Individual sessions can still override.
        </p>

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
              minWidth={180}
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
              minWidth={180}
            />
          }
        />
        <Row
          label="Prompt caching"
          description="Mark the Anthropic system prompt with cache_control. Saves ~90% on repeated turns."
          source={sources.promptCachingEnabled}
          disabledReason={cachingEnv ? envDisabledReason : undefined}
          right={
            <ToggleLink
              checked={values.promptCachingEnabled}
              disabled={cachingEnv || busyField === 'promptCachingEnabled'}
              onChange={(next) => { void updateField('promptCachingEnabled', next); }}
            />
          }
        />
      </section>

      {/* 05 — SAFETY */}
      <section>
        <SectionLabel number="05">SAFETY</SectionLabel>
        <p style={{
          fontSize: 13,
          color: 'var(--t-text-secondary)',
          lineHeight: 1.55,
          maxWidth: 580,
          margin: 0,
          marginBottom: 4,
        }}>
          o8 runs Codex with the <span style={{ fontFamily: MONO_FONT_STACK, fontSize: 12 }}>danger-full-access</span>{' '}
          sandbox inside isolated worktrees. Review the diff before merging — the orchestrator gates every packet.
        </p>
        <div style={{ marginTop: 14 }}>
          <HairlineRule />
        </div>
      </section>
    </div>
  );
}
