'use client';

/** Provider and model choices share one settings state; task behavior lives in Dispatch. */

import { useEffect, useState } from 'react';

import {
  APP_FONT_STACK,
  SettingsToggleButton,
  TabHeading,
  SETTINGS_CONTENT_MAX_WIDTH,
  type SettingsTab,
} from './shared';
import { SettingsGroup, SettingsRow, ValuePill } from './grouped';
import { useModelSettings } from './useModelSettings';
import { ORCHESTRATOR_RUNTIMES } from '@/lib/orchestrator/runtime-capabilities';
import {
  PickerMenu,
  BRAIN_CODEX_MODEL_OPTIONS,
  ORCHESTRATOR_MODEL_OPTIONS,
  CODEX_WORKER_EFFORT_OPTIONS,
  CLAUDE_WORKER_EFFORT_OPTIONS,
  ENV_LOCKED_REASON,
  type OperatorDefaults,
  type ThinkingEffort,
} from './dispatch-shared';
import { ClaudeCodeHarnessSection } from './ClaudeCodeHarnessSection';
import { ModelRoutingControls } from './ModelRoutingControls';
import { DispatchFoundersSection } from './DispatchFoundersSection';
import { SettingsAdvanced } from './SettingsAdvanced';
import { AgentRoleRoutingSection } from './AgentRoleRoutingSection';

// ── Runtime detection (real, via /api/setup/detect) ──

interface DetectedTool {
  id: string;
  detected: boolean;
  ready?: boolean;
  authHint?: string;
}

type DetectState = 'loading' | 'ready' | 'error';

// ── Row icons (raw SVG only — React icon libs don't render in the webview) ──

function RuntimeDot({ color }: { color: string }) {
  return (
    <svg width={12} height={12} viewBox="0 0 12 12" style={{ display: 'block', flexShrink: 0 }}>
      <circle cx="6" cy="6" r="4.5" fill={color} />
    </svg>
  );
}

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

// Short, honest one-liners keyed off runtime-capabilities.ts (its `description`
// strings run long; these fit a settings row).
const RUNTIME_BLURB: Record<string, string> = {
  codex: 'Codex connection and default worker effort',
  'claude-code': 'Claude Code connection and default worker effort',
  antigravity: 'Google account connection for agent tasks',
  '3code': 'Uses the providers and models configured in 3code',
  opencode: 'Uses the providers configured in OpenCode',
  cursor: 'Cursor account or API key connection',
  grok: 'Uses the model selected in Grok Build',
};

function DetectionPill({ tool, state }: { tool: DetectedTool | undefined; state: DetectState }) {
  if (state === 'error') return <ValuePill>Unavailable</ValuePill>;
  if (state === 'loading') {
    return <ValuePill>Checking…</ValuePill>;
  }
  if (!tool || !tool.detected) {
    return <ValuePill>Not installed</ValuePill>;
  }
  if (tool.ready === true) {
    return <ValuePill tone="success">Ready</ValuePill>;
  }
  // Detected but auth not confirmed (or retired, ready===false).
  return <ValuePill>{tool.ready === false ? 'Sign in' : 'Installed'}</ValuePill>;
}

function TrailingCluster({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
      {children}
    </div>
  );
}

export function ModelsTab({ onNavigateTab }: { onNavigateTab?: (tab: SettingsTab) => void }) {
  const { data, loading, notice, busyField, updateField } = useModelSettings();

  // ── Runtime detection ──
  const [detectState, setDetectState] = useState<DetectState>('loading');
  const [tools, setTools] = useState<Record<string, DetectedTool>>({});

  useEffect(() => {
    let alive = true;
    fetch('/api/setup/detect', { cache: 'no-store' })
      .then((r) => { if (!r.ok) throw new Error('Tool detection failed'); return r.json(); })
      .then((payload: { tools?: DetectedTool[] }) => {
        if (!alive) return;
        const map: Record<string, DetectedTool> = {};
        for (const t of payload.tools ?? []) {
          if (t && typeof t.id === 'string') map[t.id] = t;
        }
        setTools(map);
        setDetectState('ready');
      })
      .catch(() => { if (alive) setDetectState('error'); });
    return () => { alive = false; };
  }, []);

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

  const runtimeSubtitle = (id: keyof typeof ORCHESTRATOR_RUNTIMES) => {
    const cap = ORCHESTRATOR_RUNTIMES[id];
    return RUNTIME_BLURB[id] ?? cap.shortLabel;
  };

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
        title="models & providers"
        subtitle="Manage orchestrator and worker connections here. Choose their models in the workspace composer."
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

      <SettingsAdvanced label="Connected tools" description={detectState === 'loading'
        ? 'Checking installed tools…'
        : detectState === 'error' ? 'Could not check connections. Reopen this page to try again.'
        : `Ready: ${Object.entries(tools).filter(([id, tool]) => id in RUNTIME_BLURB && tool.ready).map(([id]) => ORCHESTRATOR_RUNTIMES[id as keyof typeof ORCHESTRATOR_RUNTIMES].label).join(', ') || 'none confirmed'}. Expand to see connection status and worker options.`}>
        <SettingsGroup
          footnote="Installed tools and their default thinking effort. Availability is detected from your machine."
        >
          {/* Codex — worker effort */}
          <SettingsRow
            icon={<RuntimeDot color={ORCHESTRATOR_RUNTIMES.codex.accentColor} />}
            label={ORCHESTRATOR_RUNTIMES.codex.label}
            subtitle={lockedSub('codexWorkerEffort', runtimeSubtitle('codex'))}
            accessory={
              <TrailingCluster>
                <DetectionPill tool={tools.codex} state={detectState} />
                <PickerMenu<ThinkingEffort>
                  value={values.codexWorkerEffort}
                  options={CODEX_WORKER_EFFORT_OPTIONS}
                  onChange={(next) => { updateField('codexWorkerEffort', next); }}
                  disabled={envLocked('codexWorkerEffort') || busyField === 'codexWorkerEffort'}
                  minWidth={130}
                />
              </TrailingCluster>
            }
            divider
          />
          {/* Claude Code — worker effort */}
          <SettingsRow
            icon={<RuntimeDot color={ORCHESTRATOR_RUNTIMES['claude-code'].accentColor} />}
            label={ORCHESTRATOR_RUNTIMES['claude-code'].label}
            subtitle={lockedSub('claudeWorkerEffort', runtimeSubtitle('claude-code'))}
            accessory={
              <TrailingCluster>
                <DetectionPill tool={tools['claude-code']} state={detectState} />
                <PickerMenu<ThinkingEffort>
                  value={values.claudeWorkerEffort}
                  options={CLAUDE_WORKER_EFFORT_OPTIONS}
                  onChange={(next) => { updateField('claudeWorkerEffort', next); }}
                  disabled={envLocked('claudeWorkerEffort') || busyField === 'claudeWorkerEffort'}
                  minWidth={130}
                />
              </TrailingCluster>
            }
            divider
          />
          {/* Grok — detection only (no persisted per-runtime toggle) */}
          <SettingsRow
            icon={<RuntimeDot color={ORCHESTRATOR_RUNTIMES.grok.accentColor} />}
            label={ORCHESTRATOR_RUNTIMES.grok.label}
            subtitle={runtimeSubtitle('grok')}
            accessory={<TrailingCluster><DetectionPill tool={tools.grok} state={detectState} /></TrailingCluster>}
            divider
          />
          {/* Cursor — detection only */}
          <SettingsRow
            icon={<RuntimeDot color={ORCHESTRATOR_RUNTIMES.cursor.accentColor} />}
            label={ORCHESTRATOR_RUNTIMES.cursor.label}
            subtitle={runtimeSubtitle('cursor')}
            accessory={<TrailingCluster><DetectionPill tool={tools.cursor} state={detectState} /></TrailingCluster>}
            divider
          />
          <SettingsRow
            icon={<RuntimeDot color={ORCHESTRATOR_RUNTIMES.antigravity.accentColor} />}
            label="Antigravity"
            subtitle={tools.antigravity?.authHint ?? runtimeSubtitle('antigravity')}
            accessory={<DetectionPill tool={tools.antigravity} state={detectState} />}
            divider
          />
          <SettingsRow
            icon={<RuntimeDot color={ORCHESTRATOR_RUNTIMES['3code'].accentColor} />}
            label="3code"
            subtitle={runtimeSubtitle('3code')}
            accessory={<DetectionPill tool={tools['3code']} state={detectState} />}
            divider
          />
          {/* opencode — enable toggle (experimentalOpencode) */}
          <SettingsRow
            icon={<RuntimeDot color={ORCHESTRATOR_RUNTIMES.opencode.accentColor} />}
            label={ORCHESTRATOR_RUNTIMES.opencode.label}
            subtitle={lockedSub('experimentalOpencode', runtimeSubtitle('opencode'))}
            accessory={
              <TrailingCluster>
                <DetectionPill tool={tools.opencode} state={detectState} />
                <SettingsToggleButton
                  checked={values.experimentalOpencode}
                  disabled={envLocked('experimentalOpencode') || busyField === 'experimentalOpencode'}
                  onChange={(next) => {
                    updateField('experimentalOpencode', next);
                    if (!next && values.defaultDispatchRuntime === 'opencode') {
                      updateField('defaultDispatchRuntime', 'codex');
                    }
                  }}
                />
              </TrailingCluster>
            }
          />
        </SettingsGroup>
      </SettingsAdvanced>

      <SettingsAdvanced label="Claude Code settings" description="Model connection and account options for Claude orchestrators and workers."
        initiallyOpen={values.subscriptionProfile === 'claude-only' || (values.subscriptionProfile !== 'codex-only' && (values.orchestratorBackend === 'claude' || values.orchestratorBackend === 'collide' || (values.orchestratorBackend === 'auto' && values.inAppOrchestratorEnabled)))}>
        <ClaudeCodeHarnessSection />
      {/* ── Orchestrator ── */}
      <section style={{ marginTop: 28 }}>
        <SettingsGroup
          header="Claude account model"
          footnote="The orchestrator model used with the native account connection. Other connections use their own model controls above."
        >
          <SettingsRow
            icon={<CpuIcon />}
            label="Native Claude model"
            subtitle={lockedSub('orchestratorModel', 'Used with Native account. Other connections use the model selected above.')}
            accessory={
              <PickerMenu<string>
                value={values.orchestratorModel}
                options={ORCHESTRATOR_MODEL_OPTIONS}
                onChange={(next) => { updateField('orchestratorModel', next); }}
                disabled={envLocked('orchestratorModel') || busyField === 'orchestratorModel'}
                minWidth={150}
              />
            }
            disabled={envLocked('orchestratorModel') || busyField === 'orchestratorModel'}
            divider
          />
        </SettingsGroup>
      </section>

      </SettingsAdvanced>

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
          header="Metered packet limits"
          footnote="Captured on each gateway-backed packet at launch. Authoritative cost stops the worker first; input tokens are the fail-closed fallback when cost is unavailable."
        >
          <SettingsRow
            icon={<CpuIcon />}
            label="Cost cap"
            subtitle="Maximum gateway-reported spend per packet (USD)"
            accessory={(
              <input
                key={values.meteredPacketCostCapUsd}
                type="number"
                min="0.01"
                step="0.01"
                defaultValue={values.meteredPacketCostCapUsd}
                disabled={busyField === 'meteredPacketCostCapUsd'}
                onBlur={(event) => { updateField('meteredPacketCostCapUsd', Number(event.currentTarget.value)); }}
                style={{ width: 92, minHeight: 30, borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--t-input-border)', borderRadius: 8, background: 'var(--t-input-bg)', color: 'var(--t-text)', paddingLeft: 9, paddingRight: 9, fontFamily: 'var(--font-mono, "SF Mono", Menlo, monospace)', fontSize: 11 }}
              />
            )}
            divider
          />
          <SettingsRow
            icon={<CpuIcon />}
            label="Input fallback"
            subtitle="Token ceiling used only when gateway cost is unknown"
            accessory={(
              <input
                key={values.meteredPacketInputTokenCap}
                type="number"
                min="1"
                step="1000"
                defaultValue={values.meteredPacketInputTokenCap}
                disabled={busyField === 'meteredPacketInputTokenCap'}
                onBlur={(event) => { updateField('meteredPacketInputTokenCap', Number(event.currentTarget.value)); }}
                style={{ width: 92, minHeight: 30, borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--t-input-border)', borderRadius: 8, background: 'var(--t-input-bg)', color: 'var(--t-text)', paddingLeft: 9, paddingRight: 9, fontFamily: 'var(--font-mono, "SF Mono", Menlo, monospace)', fontSize: 11 }}
              />
            )}
          />
        </SettingsGroup>
      </section>

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

      <SettingsAdvanced label="Advanced routing" description="Thinking overrides, Brain tuning, and details about which provider handles each job.">
        <DispatchFoundersSection values={values} sources={sources} busyField={busyField} updateField={updateField} showExperimental={false} />
      <AgentRoleRoutingSection
        routes={data?.roleRoutes ?? []}
        receipts={data?.recentRoleReceipts ?? []}
      />
      </SettingsAdvanced>
    </div>
  );
}
