'use client';

/** Advanced model and Brain tuning, rendered inside Models & providers. */

import { useState } from 'react';
import {
  MONO_FONT_STACK,
  SettingsSegmented,
} from './shared';
import { useEntitlement } from '@/lib/entitlement/context';
import { ValuePill } from './grouped';
import {
  readAdaptiveThinkingEnabled,
  readUltraEffortEnabled,
  writeAdaptiveThinkingEnabled,
  writeUltraEffortEnabled,
} from '@/lib/orchestrator/thinking-preferences';
import { SettingsGroup, SettingsRow } from './grouped';
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
} from './dispatch-shared';

// ── Minimal raw-SVG glyphs for row icon tiles ──


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



interface FoundersSectionProps {
  values: OperatorDefaults;
  sources: OperatorDefaultSources;
  busyField: keyof OperatorDefaults | null;
  updateField: <K extends keyof OperatorDefaults>(field: K, value: OperatorDefaults[K]) => void;
  showExperimental: boolean;
}

function envLocked(sources: FoundersSectionProps['sources'], field: keyof OperatorDefaults): boolean {
  return sources[field] === 'env';
}

export function DispatchFoundersSection({
  values,
  sources,
  busyField,
  updateField,
}: FoundersSectionProps) {
  // Client-side pref (localStorage via thinking-preferences.ts) — moved here
  // from the env-gated API Keys tab where it was unreachable (#1450 IA pass).
  const [adaptiveThinking, setAdaptiveThinking] = useState(() => readAdaptiveThinkingEnabled());
  const [ultraEffort, setUltraEffort] = useState(() => readUltraEffortEnabled());
  // Managed-plan status mirrors inference-route.ts rule #1: an eligible plan
  // token routes Brain calls through the managed proxy first.
  const { plan } = useEntitlement();
  const managedBrain = plan === 'founder' || plan === 'pro' || plan === 'team';
  const lockedSub = (field: keyof OperatorDefaults, normal: string) =>
    envLocked(sources, field) ? ENV_LOCKED_REASON : normal;

  return (
    <>

      <section style={{ marginTop: 28 }}>
        <SettingsGroup
          header="Thinking & task models"
          footnote={<>Optional thinking, task-model, and caching overrides. Environment variables such as <span style={{ fontFamily: MONO_FONT_STACK, fontSize: 11 }}>O8_TRIAGE_MODEL</span> still win over anything set here.</>}
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
            icon={<GaugeIcon />}
            label="Show Ultra effort"
            subtitle="Ultra may fan out to sub-agents that run outside o8. Longest turns, usage limits apply."
            checked={ultraEffort}
            onToggle={(next) => { setUltraEffort(next); writeUltraEffortEnabled(next); }}
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
          header="Brain advanced"
          footnote="Advanced choices for repository answers and worker access to the Brain. These may use the selected provider or connected CLI quota."
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
            label="Pre-warm Brain runtimes"
            subtitle={lockedSub('brainWarmupEnabled', 'Start Brain runtimes early to reduce waiting. When off, a runtime starts only when needed, which may take longer.')}
            checked={values.brainWarmupEnabled}
            disabled={envLocked(sources, 'brainWarmupEnabled') || busyField === 'brainWarmupEnabled'}
            onToggle={(next) => { updateField('brainWarmupEnabled', next); }}
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
            icon={<TargetIcon />}
            label="Worker quota fallback"
            subtitle={lockedSub('crossHouseWorkerFallback', 'Redispatch capped workers sideways to the equal-tier subscription runtime')}
            checked={values.crossHouseWorkerFallback}
            disabled={busyField === 'crossHouseWorkerFallback'}
            onToggle={(next) => { updateField('crossHouseWorkerFallback', next); }}
          />
        </SettingsGroup>
      </section>


    </>
  );
}
