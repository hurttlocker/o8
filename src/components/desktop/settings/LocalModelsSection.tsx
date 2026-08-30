'use client';

import { useEffect, useState } from 'react';

import {
  APP_FONT_STACK,
  MONO_FONT_STACK,
  RAMS_CONTROL_BG,
  RAMS_CONTROL_BORDER,
  RAMS_CONTROL_ACTIVE_BORDER,
  RAMS_HAIRLINE_SOFT,
  RAMS_INK_QUIET,
  BracketLabel,
} from './shared';
import { SettingsGroup } from './grouped';

type SettingSource = 'env' | 'file' | 'default';

export interface LocalModelsValues {
  defaultDispatchModel: string;
  localInferenceBaseUrl: string;
  localEmbedModel: string;
  localChatModel: string;
}

export interface LocalModelsSources {
  defaultDispatchModel: SettingSource;
  localInferenceBaseUrl: SettingSource;
  localEmbedModel: SettingSource;
  localChatModel: SettingSource;
}

interface LocalModelsSectionProps {
  values: LocalModelsValues;
  sources: LocalModelsSources;
  busyField: string | null;
  envDisabledReason: string;
  onCommit: (field: keyof LocalModelsValues, value: string) => void;
}

const EMPTY_PROBE = { checking: false, running: false, models: [] as string[] };

function sourceLabel(source: SettingSource): string {
  if (source === 'env') return 'env override';
  if (source === 'file') return 'saved';
  return 'default';
}

// ── Free-text field (commits on blur / Enter, not per keystroke) ──

function LocalTextField({ value, placeholder, onCommit, disabled }: {
  value: string;
  placeholder?: string;
  onCommit: (next: string) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  // Re-seed the draft when the upstream value changes (after a save round-trips).
  // Adjusting state during render is React's recommended pattern for resetting
  // local state on a prop change — no effect, no cascading-render warning.
  const [seededValue, setSeededValue] = useState(value);
  if (value !== seededValue) {
    setSeededValue(value);
    setDraft(value);
  }

  const commit = () => {
    setFocused(false);
    const trimmed = draft.trim();
    if (trimmed !== value) onCommit(trimmed);
  };

  return (
    <input
      type="text"
      value={draft}
      placeholder={placeholder}
      disabled={disabled}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      onChange={(event) => setDraft(event.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={commit}
      onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
      style={{
        minWidth: 280,
        minHeight: 32,
        paddingTop: 6,
        paddingBottom: 6,
        paddingLeft: 10,
        paddingRight: 10,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: focused ? RAMS_CONTROL_ACTIVE_BORDER : RAMS_CONTROL_BORDER,
        borderRadius: 9,
        background: RAMS_CONTROL_BG,
        color: 'var(--t-text)',
        fontSize: 12,
        fontFamily: MONO_FONT_STACK,
        letterSpacing: '-0.005em',
        opacity: disabled ? 0.6 : 1,
        cursor: disabled ? 'not-allowed' : 'text',
        outline: 'none',
        transition: 'border-color 150ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
    />
  );
}

function PresetChip({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      style={{
        minHeight: 26,
        paddingTop: 4,
        paddingBottom: 4,
        paddingLeft: 10,
        paddingRight: 10,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: RAMS_CONTROL_BORDER,
        borderRadius: 7,
        background: 'transparent',
        color: disabled ? RAMS_INK_QUIET : 'var(--t-text-muted)',
        fontSize: 11,
        fontWeight: 400,
        fontFamily: APP_FONT_STACK,
        letterSpacing: '-0.005em',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {label}
    </button>
  );
}

function ProbeBadge({ configured, checking, running, modelCount }: {
  configured: boolean;
  checking: boolean;
  running: boolean;
  modelCount: number;
}) {
  const label = !configured
    ? `not set / ${modelCount} models`
    : checking
      ? `checking / ${modelCount} models`
      : running
        ? `running / ${modelCount} models`
        : `offline / ${modelCount} models`;
  const color = checking
    ? 'var(--t-brand-orange, #f59e0b)'
    : running
      ? 'var(--t-success)'
      : RAMS_INK_QUIET;

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        color,
        fontSize: 11,
        fontFamily: MONO_FONT_STACK,
        letterSpacing: 0,
      }}
    >
      <span style={{ fontSize: 10, lineHeight: 1 }}>●</span>
      {label}
    </span>
  );
}

// ── Row (mirrors the parent tab's Row geometry) ──

function FieldRow({ label, description, source, control, divider = false }: {
  label: string;
  description: React.ReactNode;
  source: SettingSource;
  control: React.ReactNode;
  divider?: boolean;
}) {
  return (
    <div
      style={{
        paddingTop: 12,
        paddingBottom: 12,
        paddingLeft: 14,
        paddingRight: 14,
        borderBottom: divider ? `1px solid ${RAMS_HAIRLINE_SOFT}` : 'none',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 20,
        flexWrap: 'wrap',
      }}
    >
      <div style={{ minWidth: 0, flex: '1 1 300px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13.5, fontWeight: 400, color: 'var(--t-text)', letterSpacing: '-0.01em' }}>
            {label}
          </span>
          {source === 'env' ? <BracketLabel tone="quiet">{sourceLabel(source)}</BracketLabel> : null}
        </div>
        <div style={{ fontSize: 12, color: 'var(--t-text-secondary)', lineHeight: 1.55 }}>
          {description}
        </div>
      </div>
      <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
        {control}
      </div>
    </div>
  );
}

export function LocalModelsSection({ values, sources, busyField, envDisabledReason, onCommit }: LocalModelsSectionProps) {
  const dispatchEnv = sources.defaultDispatchModel === 'env';
  const baseUrlEnv = sources.localInferenceBaseUrl === 'env';
  const embedEnv = sources.localEmbedModel === 'env';
  const chatEnv = sources.localChatModel === 'env';
  const configuredBaseUrl = values.localInferenceBaseUrl.trim();
  const [probeResult, setProbeResult] = useState<{ baseUrl: string; value: typeof EMPTY_PROBE } | null>(null);
  const probe = !configuredBaseUrl
    ? EMPTY_PROBE
    : probeResult?.baseUrl === configuredBaseUrl
      ? probeResult.value
      : { ...(probeResult?.value ?? EMPTY_PROBE), checking: true };

  useEffect(() => {
    if (!configuredBaseUrl) return;

    let cancelled = false;
    fetch('/api/setup/local-inference/probe', { cache: 'no-store' })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (cancelled) return;
        const models = Array.isArray(payload.models)
          ? payload.models.filter((item: unknown): item is string => typeof item === 'string')
          : [];
        setProbeResult({
          baseUrl: configuredBaseUrl,
          value: { checking: false, running: response.ok && payload.running === true, models },
        });
      })
      .catch(() => {
        if (!cancelled) setProbeResult({ baseUrl: configuredBaseUrl, value: EMPTY_PROBE });
      });

    return () => {
      cancelled = true;
    };
  }, [configuredBaseUrl]);

  return (
    <section style={{ marginTop: 28 }}>
      <SettingsGroup
        header="Local models"
        footnote="Run o8 with zero cloud keys. Point dispatch at a model on your own machine (Ollama / LM Studio) and the Engineering Brain embeds locally too. Environment variables still win — these are the persisted fallback."
      >
      <FieldRow
        divider
        label="Dispatch model"
        source={sources.defaultDispatchModel}
        description={(
          <>
            Workers, the orchestrator, and Brain answers run on this model. Prefix
            with <code style={{ fontFamily: MONO_FONT_STACK }}>ollama:</code> or{' '}
            <code style={{ fontFamily: MONO_FONT_STACK }}>lmstudio:</code> to run fully local.
            Empty = each runtime&rsquo;s cloud default.
            {dispatchEnv ? <div style={{ marginTop: 4, color: RAMS_INK_QUIET, fontSize: 11 }}>{envDisabledReason}</div> : null}
          </>
        )}
        control={(
          <>
            <div style={{ display: 'flex', gap: 6 }}>
              <PresetChip label="Ollama" disabled={dispatchEnv} onClick={() => onCommit('defaultDispatchModel', 'ollama:qwen2.5-coder:32b')} />
              <PresetChip label="LM Studio" disabled={dispatchEnv} onClick={() => onCommit('defaultDispatchModel', 'lmstudio:qwen2.5-coder')} />
              <PresetChip label="Cloud" disabled={dispatchEnv} onClick={() => onCommit('defaultDispatchModel', '')} />
            </div>
            <LocalTextField
              value={values.defaultDispatchModel}
              placeholder="ollama:qwen2.5-coder:32b"
              disabled={dispatchEnv || busyField === 'defaultDispatchModel'}
              onCommit={(next) => onCommit('defaultDispatchModel', next)}
            />
          </>
        )}
      />

      <FieldRow
        divider
        label="Local endpoint"
        source={sources.localInferenceBaseUrl}
        description={(
          <>
            OpenAI-compatible base URL for local Brain embedding and chat calls. No
            trailing <code style={{ fontFamily: MONO_FONT_STACK }}>/v1</code>.
            <div style={{ marginTop: 8 }}>
              <ProbeBadge
                configured={Boolean(values.localInferenceBaseUrl.trim())}
                checking={probe.checking}
                running={probe.running}
                modelCount={probe.models.length}
              />
            </div>
            {baseUrlEnv ? <div style={{ marginTop: 4, color: RAMS_INK_QUIET, fontSize: 11 }}>{envDisabledReason}</div> : null}
          </>
        )}
        control={(
          <>
            <div style={{ display: 'flex', gap: 6 }}>
              <PresetChip label="Ollama :11434" disabled={baseUrlEnv} onClick={() => onCommit('localInferenceBaseUrl', 'http://localhost:11434')} />
              <PresetChip label="LM Studio :1234" disabled={baseUrlEnv} onClick={() => onCommit('localInferenceBaseUrl', 'http://localhost:1234')} />
            </div>
            <LocalTextField
              value={values.localInferenceBaseUrl}
              placeholder="http://localhost:11434"
              disabled={baseUrlEnv || busyField === 'localInferenceBaseUrl'}
              onCommit={(next) => onCommit('localInferenceBaseUrl', next)}
            />
          </>
        )}
      />

      <FieldRow
        divider
        label="Chat model"
        source={sources.localChatModel}
        description={(
          <>
            Local chat model for Brain compose/classify and dictation polish.
            Needs the endpoint above. Empty = cloud or managed route.
            {chatEnv ? <div style={{ marginTop: 4, color: RAMS_INK_QUIET, fontSize: 11 }}>{envDisabledReason}</div> : null}
          </>
        )}
        control={(
          <>
            <div style={{ display: 'flex', gap: 6 }}>
              <PresetChip label="qwen2.5-coder:7b" disabled={chatEnv} onClick={() => onCommit('localChatModel', 'qwen2.5-coder:7b')} />
              <PresetChip label="qwen2.5-coder:32b" disabled={chatEnv} onClick={() => onCommit('localChatModel', 'qwen2.5-coder:32b')} />
              <PresetChip label="Cloud" disabled={chatEnv} onClick={() => onCommit('localChatModel', '')} />
            </div>
            <LocalTextField
              value={values.localChatModel}
              placeholder="qwen2.5-coder:7b"
              disabled={chatEnv || busyField === 'localChatModel'}
              onCommit={(next) => onCommit('localChatModel', next)}
            />
          </>
        )}
      />

      <FieldRow
        label="Embedding model"
        source={sources.localEmbedModel}
        description={(
          <>
            Local embedding model for the Brain (e.g.{' '}
            <code style={{ fontFamily: MONO_FONT_STACK }}>nomic-embed-text</code>). Needs the
            endpoint above. Empty = Brain uses keyword search only.
            {embedEnv ? <div style={{ marginTop: 4, color: RAMS_INK_QUIET, fontSize: 11 }}>{envDisabledReason}</div> : null}
          </>
        )}
        control={(
          <LocalTextField
            value={values.localEmbedModel}
            placeholder="nomic-embed-text"
            disabled={embedEnv || busyField === 'localEmbedModel'}
            onCommit={(next) => onCommit('localEmbedModel', next)}
          />
        )}
      />
      </SettingsGroup>
    </section>
  );
}
