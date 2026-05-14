'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

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
  CornerBrackets,
  HairlineRule,
  SectionLabel,
  SettingsToggleButton,
  TabBreadcrumb,
  TabHeading,
} from './shared';

type OverlapGateMode = 'advisory' | 'strict';
type ThinkingEffort = 'adaptive' | 'low' | 'medium' | 'high' | 'max' | 'xhigh';
type SettingSource = 'env' | 'file' | 'default';

type DispatchRuntime = 'codex' | 'gemini' | 'opencode';
type ClassAComposer = 'auto' | 'haiku-cli' | 'sonnet-cli';

interface OperatorDefaults {
  parallelCap: number;
  overlapGate: OverlapGateMode;
  healBotEnabled: boolean;
  supervisorAutoEscalate: boolean;
  thinkingEffort: ThinkingEffort;
  promptCachingEnabled: boolean;
  orchestratorModel: string;
  defaultDispatchRuntime: DispatchRuntime;
  experimentalOpencode: boolean;
  classAComposer: ClassAComposer;
  inAppOrchestratorEnabled: boolean;
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

const DISPATCH_RUNTIME_OPTIONS: Array<{ value: DispatchRuntime; label: string; detail: string }> = [
  { value: 'codex', label: 'Codex', detail: 'OpenAI CLI — the default workhorse.' },
  { value: 'gemini', label: 'Gemini', detail: 'Google Gemini 3 Pro CLI — fastest for parallel fan-out.' },
  { value: 'opencode', label: 'opencode', detail: 'OSS CLI — routes through your configured provider keys.' },
];

// Note for the operator: the orchestrator chat itself is Claude Code under
// the hood. If you don't have another CLI (Codex / Gemini / opencode), don't
// have a second sub, or just don't want a fleet of dispatched agents, the
// orchestrator can do the work inline via native Claude sub-agents (Agent
// tool, isolated worktrees, etc.). Dispatch is for fanning work out to a
// non-Claude runtime — Anthropic ships Claude-on-Claude better than we can
// wrap, so we don't dispatch claude-code anymore. See issue #650.

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

function SegmentedControl<T extends string>({ value, options, onChange, disabled }: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (next: T) => void;
  disabled?: boolean;
}) {
  return (
    <div style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            disabled={disabled}
            onClick={() => onChange(opt.value)}
            style={{
              position: 'relative',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              minHeight: 44,
              minWidth: 44,
              fontFamily: MONO_FONT_STACK,
              fontSize: 11,
              fontWeight: 400,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: active ? RAMS_ACCENT : 'var(--t-text-muted)',
              background: active ? 'rgba(255, 90, 31, 0.08)' : 'transparent',
              border: 'none',
              paddingTop: 8,
              paddingBottom: 8,
              paddingLeft: 14,
              paddingRight: 14,
              cursor: disabled ? 'not-allowed' : 'pointer',
              opacity: disabled ? 0.6 : 1,
              transition: 'background 150ms cubic-bezier(0.22, 1, 0.36, 1)',
            }}
          >
            {active ? <CornerBrackets inset={3} armLength={6} /> : null}
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
          minHeight: 44,
          paddingTop: 0,
          paddingBottom: 0,
          paddingLeft: 14,
          paddingRight: 12,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: open ? RAMS_CONTROL_ACTIVE_BORDER : RAMS_CONTROL_BORDER,
          borderRadius: 8,
          background: RAMS_CONTROL_BG,
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
          letterSpacing: '-0.005em',
          transition: 'background 150ms cubic-bezier(0.22, 1, 0.36, 1), border-color 150ms cubic-bezier(0.22, 1, 0.36, 1)',
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
          style={{ flexShrink: 0, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 160ms cubic-bezier(0.22, 1, 0.36, 1)', color: RAMS_INK_QUIET }}
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
            border: `1px solid ${RAMS_CONTROL_BORDER}`,
            borderRadius: 8,
            background: 'var(--t-panel-solid, var(--t-panel))',
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
                  minHeight: 44,
                  justifyContent: 'center',
                  paddingTop: 8,
                  paddingBottom: 8,
                  paddingLeft: 12,
                  paddingRight: 12,
                  border: 'none',
                  background: 'transparent',
                  color: isActive ? RAMS_ACCENT : 'var(--t-text)',
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
  const runtimeEnv = sources?.defaultDispatchRuntime === 'env';
  const classAComposerEnv = sources?.classAComposer === 'env';

  const envDisabledReason = 'Controlled by environment variable. Unset to manage from Settings.';


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
          paddingTop: 2,
          paddingBottom: 2,
          fontSize: 13,
          color: 'var(--t-text)',
          lineHeight: 1.55,
        }}>
          <span style={{
            fontFamily: MONO_FONT_STACK,
            fontSize: 11,
            fontWeight: 500,
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
          How many dispatched packets the orchestrator runs at once. Env var{' '}
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
                  void updateField('parallelCap', preset.value);
                }}
                style={{
                  position: 'relative',
                  paddingTop: 16,
                  paddingBottom: 16,
                  paddingLeft: 14,
                  paddingRight: 14,
                  border: 'none',
                  borderRight: isLast ? 'none' : `1px solid ${RAMS_HAIRLINE_SOFT}`,
                  background: active ? 'rgba(255, 90, 31, 0.08)' : 'transparent',
                  color: 'var(--t-text)',
                  cursor: parallelCapEnv ? 'not-allowed' : 'pointer',
                  fontFamily: APP_FONT_STACK,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  textAlign: 'left',
                  opacity: parallelCapEnv ? 0.55 : 1,
                  transition: 'background 150ms cubic-bezier(0.22, 1, 0.36, 1)',
                }}
              >
                {active ? <CornerBrackets /> : null}
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
            <SettingsToggleButton
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
            <SettingsToggleButton
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
            <SettingsToggleButton
              checked={values.promptCachingEnabled}
              disabled={cachingEnv || busyField === 'promptCachingEnabled'}
              onChange={(next) => { void updateField('promptCachingEnabled', next); }}
            />
          }
        />
      </section>

      {/* 05 — DISPATCH RUNTIME */}
      <section>
        <SectionLabel number="05">DISPATCH RUNTIME</SectionLabel>
        <p style={{
          fontSize: 13,
          color: 'var(--t-text-secondary)',
          lineHeight: 1.55,
          maxWidth: 580,
          margin: 0,
          marginBottom: 4,
        }}>
          Which CLI the orchestrator spawns when you say &quot;dispatch&quot; without naming a runtime. Pick whichever you actually have a subscription or API key for — otherwise every dispatch dies on the CLI boundary.
        </p>
        <Row
          label="Default dispatch runtime"
          description="Applied to dispatch_codex_task and create-mission when runtime is omitted. The orchestrator can still override per-task."
          source={sources.defaultDispatchRuntime}
          disabledReason={runtimeEnv ? envDisabledReason : undefined}
          right={
            <PickerMenu<DispatchRuntime>
              value={values.defaultDispatchRuntime}
              options={DISPATCH_RUNTIME_OPTIONS.filter((opt) => opt.value !== 'opencode' || values.experimentalOpencode)}
              onChange={(next) => { void updateField('defaultDispatchRuntime', next); }}
              disabled={runtimeEnv || busyField === 'defaultDispatchRuntime'}
              minWidth={180}
            />
          }
        />
        <Row
          label="Experimental: opencode"
          description="Show opencode in dispatch pickers. Off by default for v1 — the adapter ships wired but hidden until we've dogfooded more sessions."
          source={sources.experimentalOpencode}
          disabledReason={sources?.experimentalOpencode === 'env' ? envDisabledReason : undefined}
          right={
            <SettingsToggleButton
              checked={values.experimentalOpencode}
              disabled={sources?.experimentalOpencode === 'env' || busyField === 'experimentalOpencode'}
              onChange={(next) => {
                void updateField('experimentalOpencode', next);
                // If turning off while opencode is the selected default, snap to codex
                if (!next && values.defaultDispatchRuntime === 'opencode') {
                  void updateField('defaultDispatchRuntime', 'codex');
                }
              }}
            />
          }
        />
      </section>

      {/* 06 — Q&A COMPOSER */}
      <section style={{ marginBottom: 32 }}>
        <SectionLabel number="06">Q&A COMPOSER</SectionLabel>
        <p style={{ fontSize: 13, color: 'var(--t-text-secondary)', lineHeight: 1.55, maxWidth: 580, margin: 0, marginBottom: 4 }}>
          Class A composer model used to answer Cortex /ask questions. Eval-mode (smoke) keeps OpenRouter Sonnet 4.6. Env var{' '}
          <span style={{ fontFamily: MONO_FONT_STACK, fontSize: 12, color: 'var(--t-text-secondary)' }}>O8_CLASS_A_COMPOSER</span>
          {' '}overrides.
        </p>
        <Row
          label="Class A composer"
          description={values.classAComposer === 'sonnet-cli' ? 'Sonnet CLI: best quality, slower bootstrap. Skips Haiku and Codex tiers.' : 'Haiku CLI: fastest free path. Falls back through Codex / OpenRouter / Flash / Sonnet CLI.'}
          source={sources.classAComposer}
          disabledReason={classAComposerEnv ? envDisabledReason : undefined}
          right={
            <PickerMenu<ClassAComposer>
              value={values.classAComposer === 'sonnet-cli' ? 'sonnet-cli' : 'haiku-cli'}
              options={[{ value: 'haiku-cli', label: 'Haiku', detail: 'Fastest, free for Claude Max users.' }, { value: 'sonnet-cli', label: 'Sonnet', detail: 'Best quality, free, slower bootstrap.' }]}
              onChange={(next) => { void updateField('classAComposer', next); }}
              disabled={classAComposerEnv || busyField === 'classAComposer'}
              minWidth={180}
            />
          }
        />
      </section>

      {/* 07 — IN-APP ORCHESTRATOR CHAT */}
      <section style={{ marginBottom: 32 }}>
        <SectionLabel number="07">IN-APP ORCHESTRATOR CHAT</SectionLabel>
        <p style={{
          fontSize: 13,
          color: 'var(--t-text-secondary)',
          lineHeight: 1.55,
          maxWidth: 580,
          margin: 0,
          marginBottom: 4,
        }}>
          The chat panel inside o8 spawns{' '}
          <span style={{ fontFamily: MONO_FONT_STACK, fontSize: 12 }}>claude -p</span>{' '}
          per turn. After Anthropic&apos;s June 15 2026 pricing change, that bills against
          your $20–$200/mo Agent SDK credit pool. Default OFF — drive o8 from Claude Code
          or Claude Desktop via the operator MCP server to stay on the unlimited
          interactive pool. Env{' '}
          <span style={{ fontFamily: MONO_FONT_STACK, fontSize: 12 }}>O8_IN_APP_ORCHESTRATOR_ENABLED</span>{' '}
          overrides.
        </p>
        <Row
          label="Enable in-app orchestrator chat"
          description={values.inAppOrchestratorEnabled
            ? 'On — every turn draws from your Anthropic SDK credit pool. Watch your monthly cap.'
            : 'Off — the chat composer is locked. Talk to Claude in Claude Code / Desktop instead.'}
          source={sources.inAppOrchestratorEnabled}
          disabledReason={sources?.inAppOrchestratorEnabled === 'env' ? envDisabledReason : undefined}
          right={
            <SettingsToggleButton
              checked={values.inAppOrchestratorEnabled}
              disabled={sources?.inAppOrchestratorEnabled === 'env' || busyField === 'inAppOrchestratorEnabled'}
              onChange={(next) => {
                void updateField('inAppOrchestratorEnabled', next);
              }}
            />
          }
        />
      </section>

      {/* 08 — SAFETY */}
      <section>
        <SectionLabel number="08">SAFETY</SectionLabel>
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
