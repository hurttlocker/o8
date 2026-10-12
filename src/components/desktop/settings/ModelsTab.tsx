'use client';

/** Provider and model choices share one settings state; task behavior lives in Dispatch. */


import {
  APP_FONT_STACK,
  TabHeading,
  SETTINGS_CONTENT_MAX_WIDTH,
  type SettingsTab,
} from './shared';
import { SettingsGroup, SettingsRow } from './grouped';
import { useModelSettings } from './useModelSettings';
import {
  PickerMenu,
  BRAIN_CODEX_MODEL_OPTIONS,
  CODEX_WORKER_EFFORT_OPTIONS,
  ENV_LOCKED_REASON,
  type OperatorDefaults,
  type ThinkingEffort,
} from './dispatch-shared';
import { ModelRoutingControls } from './ModelRoutingControls';
import { DispatchFoundersSection } from './DispatchFoundersSection';
import { SettingsAdvanced } from './SettingsAdvanced';
import { AgentRoleRoutingSection } from './AgentRoleRoutingSection';

function CpuIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <line x1="9" y1="1" x2="9" y2="4" />
      <line x1="15" y1="1" x2="15" y2="4" />
      <line x1="9" y1="20" x2="9" y2="23" />
      <line x1="15" y1="20" x2="15" y2="23" />
      <line x1="20" y1="9" x2="23" y2="9" />
      <line x1="20" y1="14" x2="23" y2="14" />
      <line x1="1" y1="9" x2="4" y2="9" />
      <line x1="1" y1="14" x2="4" y2="14" />
    </svg>
  );
}

export function ModelsTab(props: { onNavigateTab?: (tab: SettingsTab) => void }) {
  const settings = useModelSettings();
  return <ModelDefaultsContent {...props} settings={settings} />;
}

export function ModelDefaultsContent({ settings, onNavigateTab }: { settings: ReturnType<typeof useModelSettings>; onNavigateTab?: (tab: SettingsTab) => void }) {
  const { data, loading, notice, busyField, updateField } = settings;

  if (loading && !data) {
    return (
      <div style={{ paddingTop: 40, color: 'var(--t-text-muted)', fontSize: 13, fontFamily: APP_FONT_STACK }}>
        Loading model settings...
      </div>
    );
  }

  const values = data?.values;
  const sources = data?.sources;
  if (!values || !sources) {
    return (
      <div style={{ paddingTop: 40, color: 'var(--t-brand-red, #b91c1c)', fontSize: 13, fontFamily: APP_FONT_STACK }}>
        {notice ?? 'Unable to load model settings.'}
      </div>
    );
  }

  const envLocked = (field: keyof OperatorDefaults) => sources[field] === 'env';
  const lockedSub = (field: keyof OperatorDefaults, normal: string) => (envLocked(field) ? ENV_LOCKED_REASON : normal);

  return (
    <div style={{
      paddingTop: 8,
      paddingLeft: 8,
      paddingRight: 8,
      paddingBottom: 40,
      maxWidth: SETTINGS_CONTENT_MAX_WIDTH,
      fontFamily: APP_FONT_STACK,
    }}>
      <TabHeading
        title="model defaults"
        subtitle="Choose app-wide routing and fallback behavior. Conversation models stay in the composer."
      />


      {notice ? (
        <div style={{ marginBottom: 28, fontSize: 13, color: 'var(--t-text)', lineHeight: 1.55 }}>
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

      <ModelRoutingControls data={data!} busyField={busyField} updateField={updateField} />

      <section style={{ marginTop: 28 }}>
        <SettingsGroup
          header="Engineering Brain"
          footnote="Auto uses your included managed Brain allowance when your plan has one. It never switches to a CLI, local model, or BYOK key when that allowance is unavailable. Subscription mode is an explicit choice and may use the quota of a connected CLI."
        >
          <SettingsRow
            icon={<CpuIcon />}
            label="Answer routing"
            subtitle={lockedSub('brainRoutingMode', values.brainRoutingMode === 'auto' ? 'Auto: managed inference for eligible plans' : 'Subscription: connected CLI quota may be used')}
            accessory={
              <PickerMenu<'auto' | 'subscription'>
                value={values.brainRoutingMode}
                options={[
                  { value: 'auto', label: 'Auto' },
                  { value: 'subscription', label: 'Subscription' },
                ]}
                onChange={(next) => { updateField('brainRoutingMode', next); }}
                disabled={envLocked('brainRoutingMode') || busyField === 'brainRoutingMode'}
                minWidth={140}
              />
            }
            disabled={envLocked('brainRoutingMode') || busyField === 'brainRoutingMode'}
            divider
          />
          <SettingsRow
            icon={<CpuIcon />}
            label="Codex model"
            subtitle={lockedSub('brainCodexModel', 'Model used for Brain classification and cited answers')}
            accessory={
              <PickerMenu<string>
                value={values.brainCodexModel}
                options={BRAIN_CODEX_MODEL_OPTIONS}
                onChange={(next) => { updateField('brainCodexModel', next); }}
                disabled={envLocked('brainCodexModel') || busyField === 'brainCodexModel'}
                minWidth={140}
              />
            }
            disabled={envLocked('brainCodexModel') || busyField === 'brainCodexModel'}
            divider
          />
          <SettingsRow
            icon={<CpuIcon />}
            label="Codex effort"
            subtitle={lockedSub('brainCodexEffort', 'Reasoning effort used only by Engineering Brain calls')}
            accessory={
              <PickerMenu<ThinkingEffort>
                value={values.brainCodexEffort}
                options={CODEX_WORKER_EFFORT_OPTIONS}
                onChange={(next) => { updateField('brainCodexEffort', next); }}
                disabled={envLocked('brainCodexEffort') || busyField === 'brainCodexEffort'}
                minWidth={140}
              />
            }
            disabled={envLocked('brainCodexEffort') || busyField === 'brainCodexEffort'}
          />
        </SettingsGroup>
      </section>

      <section style={{ marginTop: 28 }}>
        <SettingsGroup
          header="Codex app"
          footnote="Multitask and Fusion chats on Codex run in your own Codex home, so you can open them in the Codex app. o8 keeps its own tools, model and access mode for these turns and does not change your Codex settings. Solo chats stay private to o8. Switching this starts a new Codex thread for each chat."
        >
          <SettingsRow
            icon={<CpuIcon />}
            label="Show chats in the Codex app"
            subtitle={lockedSub('codexAppThreads', 'Read and continue o8 orchestrator chats in Codex on desktop and mobile')}
            checked={values.codexAppThreads}
            disabled={envLocked('codexAppThreads') || busyField === 'codexAppThreads'}
            onToggle={(next) => { updateField('codexAppThreads', next); }}
          />
        </SettingsGroup>
      </section>

      <ModelRoutingControls data={data!} busyField={busyField} updateField={updateField} advanced />
      <DispatchFoundersSection values={values} sources={sources} busyField={busyField} updateField={updateField} showExperimental={false} />
      <SettingsAdvanced label="Routing details" description="See which provider handles each job and the result of recent routing decisions.">
        <AgentRoleRoutingSection
          routes={data?.roleRoutes ?? []}
          receipts={data?.recentRoleReceipts ?? []}
        />
      </SettingsAdvanced>
      <section style={{ marginTop: 28 }}>
        <SettingsGroup header="More setup">
          <SettingsRow icon={<CpuIcon />} label="API keys" subtitle="Manage provider keys and find voice service keys."
            onPress={onNavigateTab ? () => onNavigateTab('api-keys') : undefined} chevron={Boolean(onNavigateTab)} divider />
          <SettingsRow icon={<CpuIcon />} label="Local models" subtitle="Connect models running on your own computer or server."
            onPress={onNavigateTab ? () => onNavigateTab('local-models') : undefined} chevron={Boolean(onNavigateTab)} divider />
          <SettingsRow icon={<CpuIcon />} label="Task review & supervision" subtitle="Automatic fixes, review behavior, and merge approval."
            onPress={onNavigateTab ? () => onNavigateTab('operator-defaults') : undefined} value="Dispatch" chevron={Boolean(onNavigateTab)} />
        </SettingsGroup>
      </section>

    </div>
  );
}
