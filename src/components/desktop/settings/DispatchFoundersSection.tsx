'use client';

/**
 * Advanced Dispatch settings (epic #1450). Operator-owned model tiers, Brain
 * routing, and local-model controls are available to every installation;
 * founder mode only reveals experimental preview flags. Every write still goes
 * through the same gated /api/panel/operator-defaults route.
 */

import { useState } from 'react';
import {
  MONO_FONT_STACK,
  SettingsSegmented,
} from './shared';
import { useEntitlement } from '@/lib/entitlement/context';
import { ValuePill } from './grouped';
import {
  readAdaptiveThinkingEnabled,
  writeAdaptiveThinkingEnabled,
} from '@/lib/orchestrator/thinking-preferences';
import { SettingsGroup, SettingsRow } from './grouped';
import { LocalModelsSection } from './LocalModelsSection';
import {
  PickerMenu,
  THINKING_EFFORT_OPTIONS,
  DISPATCH_RUNTIME_OPTIONS,
  ENV_LOCKED_REASON,
  type ClassAComposer,
  type CollideAggregator,
  type DispatchRuntime,
  type OperatorDefaults,
  type OperatorDefaultSources,
  type ThinkingEffort,
  type WorkersUseBrain,
  type WorkspaceManifestPolicy,
} from './dispatch-shared';

// ── Minimal raw-SVG glyphs for row icon tiles ──

function FlaskIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M10 2v7.31L4.34 19.03A2 2 0 0 0 6.07 22h11.86a2 2 0 0 0 1.73-2.97L14 9.31V2" />
      <line x1="8.5" y1="2" x2="15.5" y2="2" />
    </svg>
  );
}

function GaugeIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M12 15l3.5-3.5" />
      <path d="M20.3 18a10 10 0 1 0-16.6 0" />
    </svg>
  );
}

function TargetIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="2" />
    </svg>
  );
}

function ZapIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}

function BrainRowIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
      <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function CanvasIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 15l5-5 4 4 3-3 6 6" />
    </svg>
  );
}

function BrowserIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <line x1="2" y1="9" x2="22" y2="9" />
    </svg>
  );
}

interface FoundersSectionProps {
  values: OperatorDefaults;
  sources: OperatorDefaultSources;
  busyField: keyof OperatorDefaults | null;
  updateField: <K extends keyof OperatorDefaults>(field: K, value: OperatorDefaults[K]) => void;
  showExperimental: boolean;
}

type UiLoopBudgetField =
  | 'uiLoopMaxIterations'
  | 'uiLoopMaxMinutes'
  | 'uiLoopMaxDiffBytes'
  | 'uiLoopMaxDiffFiles'
  | 'uiLoopPreviewTimeoutMs';

function UiLoopBudgetInput({
  field,
  value,
  busyField,
  updateField,
}: {
  field: UiLoopBudgetField;
  value: number;
  busyField: keyof OperatorDefaults | null;
  updateField: FoundersSectionProps['updateField'];
}) {
  return (
    <input
      key={value}
      type="number"
      min="1"
      step="1"
      defaultValue={value}
      disabled={busyField === field}
      onBlur={(event) => { updateField(field, Number(event.currentTarget.value)); }}
      style={{ width: 86, minHeight: 30, borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--t-input-border)', borderRadius: 8, background: 'var(--t-input-bg)', color: 'var(--t-text)', paddingLeft: 9, paddingRight: 9, fontFamily: MONO_FONT_STACK, fontSize: 11 }}
    />
  );
}

function envLocked(sources: FoundersSectionProps['sources'], field: keyof OperatorDefaults): boolean {
  return sources[field] === 'env';
}

export function DispatchFoundersSection({
  values,
  sources,
  busyField,
  updateField,
  showExperimental,
}: FoundersSectionProps) {
  // Client-side pref (localStorage via thinking-preferences.ts) — moved here
  // from the env-gated API Keys tab where it was unreachable (#1450 IA pass).
  const [adaptiveThinking, setAdaptiveThinking] = useState(() => readAdaptiveThinkingEnabled());
  // Managed-plan status mirrors inference-route.ts rule #1: an eligible plan
  // token routes Brain calls through the managed proxy first.
  const { plan } = useEntitlement();
  const managedBrain = plan === 'founder' || plan === 'pro' || plan === 'team';
  const lockedSub = (field: keyof OperatorDefaults, normal: string) =>
    envLocked(sources, field) ? ENV_LOCKED_REASON : normal;

  return (
    <>
      {showExperimental ? <section style={{ marginTop: 28 }}>
        <SettingsGroup
          header="Experimental"
          footnote={<>Adapters and surfaces that ship wired but hidden until they&apos;ve earned defaults. Turning a runtime off snaps any picker using it back to Codex.</>}
        >
          <SettingsRow
            icon={<FlaskIcon />}
            label="OpenCode 2 runtime"
            subtitle={lockedSub('experimentalOpencode', 'Show OpenCode 2 in dispatch pickers')}
            checked={values.experimentalOpencode}
            disabled={envLocked(sources, 'experimentalOpencode') || busyField === 'experimentalOpencode'}
            onToggle={(next) => {
              updateField('experimentalOpencode', next);
              if (!next && values.defaultDispatchRuntime === 'opencode') {
                updateField('defaultDispatchRuntime', 'codex');
              }
            }}
            divider
          />
          <SettingsRow
            icon={<FlaskIcon />}
            label="Gemini runtime"
            subtitle={lockedSub('experimentalGemini', 'Show Gemini in dispatch + CLI pickers')}
            checked={values.experimentalGemini}
            disabled={envLocked(sources, 'experimentalGemini') || busyField === 'experimentalGemini'}
            onToggle={(next) => {
              updateField('experimentalGemini', next);
              if (!next && values.defaultDispatchRuntime === 'gemini') {
                updateField('defaultDispatchRuntime', 'codex');
              }
            }}
            divider
          />
          {/* Casual-chat tab toggle intentionally NOT surfaced for the beta
              (operator, 2026-07-06) — the flag still exists (experimentalChat /
              env) but the orchestrator is the only conversational surface. */}
          <SettingsRow
            icon={<CanvasIcon />}
            label={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>Canvas mode <ValuePill>Experimental</ValuePill></span>}
            subtitle={lockedSub('experimentalCanvas', 'The glass canvas — voice-first fleet surface. Sole gate.')}
            checked={values.experimentalCanvas}
            disabled={envLocked(sources, 'experimentalCanvas') || busyField === 'experimentalCanvas'}
            onToggle={(next) => { updateField('experimentalCanvas', next); }}
            divider
          />
          {/* Glass tuning lives INSIDE the canvas (its own Appearance panel) —
              the inline settings copy was redundant (operator, 2026-07-06). */}
          <SettingsRow
            icon={<BrowserIcon />}
            label="Native browser-view"
            subtitle={lockedSub('nativeBrowserView', 'Host-owned native window for the Browser pane (macOS)')}
            checked={values.nativeBrowserView}
            disabled={envLocked(sources, 'nativeBrowserView') || busyField === 'nativeBrowserView'}
            onToggle={(next) => { updateField('nativeBrowserView', next); }}
          />
        </SettingsGroup>
      </section> : null}

      <section style={{ marginTop: 28 }}>
        <SettingsGroup
          header="Model tiers"
          footnote={<>Tuning for the orchestrator&apos;s thinking budget, the Targeting Machine&apos;s triage/action tiers, and Anthropic prompt caching (saves ~90% on repeated turns). Env vars like <span style={{ fontFamily: MONO_FONT_STACK, fontSize: 11 }}>O8_TRIAGE_MODEL</span> still win over anything set here.</>}
        >
          <SettingsRow
            icon={<GaugeIcon />}
            label="Thinking effort"
            subtitle={lockedSub('thinkingEffort', 'Default effort for orchestrator turns')}
            accessory={
              <PickerMenu<ThinkingEffort>
                value={values.thinkingEffort}
                options={THINKING_EFFORT_OPTIONS}
                onChange={(next) => { updateField('thinkingEffort', next); }}
                disabled={envLocked(sources, 'thinkingEffort') || busyField === 'thinkingEffort'}
                minWidth={140}
              />
            }
            divider
          />
          <SettingsRow
            icon={<GaugeIcon />}
            label="Adaptive orchestrator thinking"
            subtitle="New turns default to adaptive and can stream summarized reasoning"
            checked={adaptiveThinking}
            onToggle={(next) => { setAdaptiveThinking(next); writeAdaptiveThinkingEnabled(next); }}
            divider
          />
          <SettingsRow
            icon={<TargetIcon />}
            label="Targeting — triage tier"
            subtitle={lockedSub('targetingTriage', 'Cheap tier: repo triage, rationales, trivial files')}
            accessory={
              <div style={{ display: 'flex', gap: 6 }}>
                <PickerMenu<DispatchRuntime>
                  value={values.targetingTriage.runtime}
                  options={DISPATCH_RUNTIME_OPTIONS.filter((opt) =>
                    (opt.value !== 'opencode' || values.experimentalOpencode) && (opt.value !== 'gemini' || values.experimentalGemini))}
                  onChange={(next) => { updateField('targetingTriage', { ...values.targetingTriage, runtime: next }); }}
                  disabled={envLocked(sources, 'targetingTriage') || busyField === 'targetingTriage'}
                  minWidth={110}
                />
                <PickerMenu<ThinkingEffort>
                  value={values.targetingTriage.effort}
                  options={THINKING_EFFORT_OPTIONS}
                  onChange={(next) => { updateField('targetingTriage', { ...values.targetingTriage, effort: next }); }}
                  disabled={envLocked(sources, 'targetingTriage') || busyField === 'targetingTriage'}
                  minWidth={110}
                />
              </div>
            }
            divider
          />
          <SettingsRow
            icon={<TargetIcon />}
            label="Targeting — action tier"
            subtitle={lockedSub('targetingAction', 'Premium tier: the Dispatch button + hard-file routing')}
            accessory={
              <div style={{ display: 'flex', gap: 6 }}>
                <PickerMenu<DispatchRuntime>
                  value={values.targetingAction.runtime}
                  options={DISPATCH_RUNTIME_OPTIONS.filter((opt) =>
                    (opt.value !== 'opencode' || values.experimentalOpencode) && (opt.value !== 'gemini' || values.experimentalGemini))}
                  onChange={(next) => { updateField('targetingAction', { ...values.targetingAction, runtime: next }); }}
                  disabled={envLocked(sources, 'targetingAction') || busyField === 'targetingAction'}
                  minWidth={110}
                />
                <PickerMenu<ThinkingEffort>
                  value={values.targetingAction.effort}
                  options={THINKING_EFFORT_OPTIONS}
                  onChange={(next) => { updateField('targetingAction', { ...values.targetingAction, effort: next }); }}
                  disabled={envLocked(sources, 'targetingAction') || busyField === 'targetingAction'}
                  minWidth={110}
                />
              </div>
            }
            divider
          />
          <SettingsRow
            icon={<ZapIcon />}
            label="Prompt caching"
            subtitle={lockedSub('promptCachingEnabled', 'Mark the Anthropic system prompt with cache_control')}
            checked={values.promptCachingEnabled}
            disabled={envLocked(sources, 'promptCachingEnabled') || busyField === 'promptCachingEnabled'}
            onToggle={(next) => { updateField('promptCachingEnabled', next); }}
          />
        </SettingsGroup>
      </section>

      <section style={{ marginTop: 28 }}>
        <SettingsGroup
          header="Brain routing"
          footnote="The Q&A composer answers /ask questions (Haiku CLI is free via the warm REPL pool). The legacy orchestrator toggle is what backend Auto follows — Codex when off, Claude when on. Workers-use-Brain Auto gives the oracle to non-frontier models only; Codex stays lean."
        >
          <SettingsRow
            icon={<ZapIcon />}
            label="Managed inference"
            subtitle={managedBrain
              ? 'Brain answers try the managed inference route first.'
              : 'Subscribe through o8 to make managed inference the first Brain route.'}
            accessory={managedBrain
              ? <ValuePill tone="success">Active</ValuePill>
              : <ValuePill>Not active</ValuePill>}
            divider
          />
          <SettingsRow
            icon={<BrainRowIcon />}
            label="Q&A composer"
            subtitle={lockedSub('classAComposer', 'Class A composer for Brain answers')}
            accessory={
              <PickerMenu<ClassAComposer>
                value={values.classAComposer}
                options={[
                  { value: 'auto', label: 'Auto', detail: 'Choose the best ready route for each request.' },
                  { value: 'haiku-cli', label: 'Haiku', detail: 'Free via the warm REPL pool.' },
                  { value: 'sonnet-cli', label: 'Sonnet', detail: 'Best quality, slower bootstrap.' },
                  { value: 'fastest', label: 'Fastest', detail: 'OpenRouter flash-lite, daily-capped.' },
                ]}
                onChange={(next) => { updateField('classAComposer', next); }}
                disabled={envLocked(sources, 'classAComposer') || busyField === 'classAComposer'}
                minWidth={140}
              />
            }
            divider
          />
          <SettingsRow
            icon={<BrainRowIcon />}
            label="Collide aggregator"
            subtitle={lockedSub('collideAggregator', 'Who synthesizes when the Collide backend runs')}
            accessory={
              <SettingsSegmented
                value={values.collideAggregator}
                onChange={(next) => { updateField('collideAggregator', next as CollideAggregator); }}
                options={[
                  { value: 'auto', label: 'Auto' },
                  { value: 'claude', label: 'Claude' },
                  { value: 'codex', label: 'Codex' },
                ]}
              />
            }
            divider
          />
          <SettingsRow
            icon={<ChatIcon />}
            label="Legacy orchestrator toggle"
            subtitle={lockedSub('inAppOrchestratorEnabled', 'What backend Auto follows: on = Claude REPL, off = Codex')}
            checked={values.inAppOrchestratorEnabled}
            disabled={envLocked(sources, 'inAppOrchestratorEnabled') || busyField === 'inAppOrchestratorEnabled'}
            onToggle={(next) => { updateField('inAppOrchestratorEnabled', next); }}
            divider
          />
          <SettingsRow
            icon={<BrainRowIcon />}
            label="Brain uses Claude CLI"
            subtitle={lockedSub('brainUseClaudeCli', 'Warm claude CLI answers (~2.7s Haiku), sub-billed')}
            checked={values.brainUseClaudeCli}
            disabled={envLocked(sources, 'brainUseClaudeCli') || busyField === 'brainUseClaudeCli'}
            onToggle={(next) => { updateField('brainUseClaudeCli', next); }}
            divider
          />
          <SettingsRow
            icon={<BrainRowIcon />}
            label="Workers use the Brain"
            subtitle={lockedSub('workersUseBrain', 'Teach dispatched workers o8 ask for cited repo answers')}
            accessory={
              <SettingsSegmented
                value={values.workersUseBrain}
                onChange={(next) => { updateField('workersUseBrain', next as WorkersUseBrain); }}
                options={[
                  { value: 'off', label: 'Off' },
                  { value: 'auto', label: 'Auto' },
                  { value: 'all', label: 'All' },
                ]}
              />
            }
            divider
          />
          <SettingsRow
            icon={<GaugeIcon />}
            label="UI loop iterations"
            subtitle="Follow-up steers allowed per Design Mode packet"
            accessory={<UiLoopBudgetInput field="uiLoopMaxIterations" value={values.uiLoopMaxIterations} busyField={busyField} updateField={updateField} />}
            divider
          />
          <SettingsRow
            icon={<GaugeIcon />}
            label="UI loop minutes"
            subtitle="Wall-time budget from the first Design Mode turn"
            accessory={<UiLoopBudgetInput field="uiLoopMaxMinutes" value={values.uiLoopMaxMinutes} busyField={busyField} updateField={updateField} />}
            divider
          />
          <SettingsRow
            icon={<GaugeIcon />}
            label="UI loop diff bytes"
            subtitle="Maximum current packet diff size"
            accessory={<UiLoopBudgetInput field="uiLoopMaxDiffBytes" value={values.uiLoopMaxDiffBytes} busyField={busyField} updateField={updateField} />}
            divider
          />
          <SettingsRow
            icon={<GaugeIcon />}
            label="UI loop diff files"
            subtitle="Maximum files in the current packet diff"
            accessory={<UiLoopBudgetInput field="uiLoopMaxDiffFiles" value={values.uiLoopMaxDiffFiles} busyField={busyField} updateField={updateField} />}
            divider
          />
          <SettingsRow
            icon={<GaugeIcon />}
            label="UI loop preview timeout"
            subtitle="Milliseconds to wait for a preview to become ready"
            accessory={<UiLoopBudgetInput field="uiLoopPreviewTimeoutMs" value={values.uiLoopPreviewTimeoutMs} busyField={busyField} updateField={updateField} />}
            divider
          />
          <SettingsRow
            icon={<TargetIcon />}
            label="Workspace manifest execution"
            subtitle={lockedSub('workspaceManifestPolicy', 'Gate checked-in setup commands before packet launch')}
            accessory={
              <SettingsSegmented
                value={values.workspaceManifestPolicy}
                onChange={(next) => { updateField('workspaceManifestPolicy', next as WorkspaceManifestPolicy); }}
                options={[
                  { value: 'disabled', label: 'Disabled' },
                  { value: 'one-approval', label: 'Approve once' },
                  { value: 'auto', label: 'Auto' },
                ]}
              />
            }
            divider
          />
          <SettingsRow
            icon={<TargetIcon />}
            label="Worker quota fallback"
            subtitle={lockedSub('crossHouseWorkerFallback', 'Redispatch capped workers sideways to the equal-tier subscription runtime')}
            checked={values.crossHouseWorkerFallback}
            disabled={busyField === 'crossHouseWorkerFallback'}
            onToggle={(next) => { updateField('crossHouseWorkerFallback', next); }}
          />
        </SettingsGroup>
      </section>

      <LocalModelsSection
        values={{
          defaultDispatchModel: values.defaultDispatchModel,
          localInferenceBaseUrl: values.localInferenceBaseUrl,
          localEmbedModel: values.localEmbedModel,
          localChatModel: values.localChatModel,
        }}
        sources={{
          defaultDispatchModel: sources.defaultDispatchModel,
          localInferenceBaseUrl: sources.localInferenceBaseUrl,
          localEmbedModel: sources.localEmbedModel,
          localChatModel: sources.localChatModel,
        }}
        busyField={busyField}
        envDisabledReason={ENV_LOCKED_REASON}
        onCommit={(field, value) => { updateField(field, value); }}
      />
    </>
  );
}
