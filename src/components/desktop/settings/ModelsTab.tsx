'use client';

/**
 * ModelsTab — the Models settings page (Cursor-parity wave 2).
 *
 * One surface for everything model-shaped: per-runtime status + tuning, the
 * orchestrator model, runtime-specific worker profiles, BYOK provider keys,
 * and local models. Shared controls use the same live backends as Dispatch;
 * harness-specific choices use their runtime adapter's persisted profile.
 * Dispatch is left intact, with a link-row across to it for backend and
 * supervision tuning that would be confusing to duplicate here.
 */

import { useCallback, useEffect, useState } from 'react';

import {
  APP_FONT_STACK,
  RAMS_INK_QUIET,
  SettingsToggleButton,
  TabHeading,
  SETTINGS_CONTENT_MAX_WIDTH,
  type SettingsTab,
} from './shared';
import { GroupFootnote, GroupHeader, SettingsGroup, SettingsRow, ValuePill } from './grouped';
import { fetchOperatorDefaults } from './operator-defaults-client';
import { ORCHESTRATOR_RUNTIMES } from '@/lib/orchestrator/runtime-capabilities';
import { ApiKeysProviderList } from './APIKeysTab';
import { LocalModelsSection } from './LocalModelsSection';
import {
  PickerMenu,
  BRAIN_CODEX_MODEL_OPTIONS,
  ORCHESTRATOR_MODEL_OPTIONS,
  CODEX_WORKER_EFFORT_OPTIONS,
  CLAUDE_WORKER_EFFORT_OPTIONS,
  ENV_LOCKED_REASON,
  type OperatorDefaults,
  type OperatorDefaultsResponse,
  type ThinkingEffort,
} from './dispatch-shared';
import { AcpModelPickerPopover } from './AcpModelPickerPopover';
import { ClaudeCodeHarnessSection } from './ClaudeCodeHarnessSection';
import { AgentRoleRoutingSection } from './AgentRoleRoutingSection';

// ── Runtime detection (real, via /api/setup/detect) ──

interface DetectedTool {
  id: string;
  detected: boolean;
  ready?: boolean;
  authHint?: string;
}

type DetectState = 'loading' | 'ready';

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

function TierLabel(tier: 'frontier' | 'standard' | 'local'): string {
  if (tier === 'frontier') return 'Frontier';
  if (tier === 'standard') return 'Standard';
  return 'Local';
}

// Short, honest one-liners keyed off runtime-capabilities.ts (its `description`
// strings run long; these fit a settings row).
const RUNTIME_BLURB: Record<string, string> = {
  codex: 'GPT-6 Astra orchestrates, GPT-5.6 Terra works',
  'claude-code': 'Claude Code harness, native account or API gateway',
  gemini: 'Retired CLI adapter — existing lanes stay readable',
  opencode: 'OpenCode 2 multi-provider CLI, routes through your provider keys',
  cursor: 'Cursor CLI worker — subscription or CURSOR_API_KEY',
  grok: 'Grok Build, using the current model selected by its CLI',
};

function DetectionPill({ tool, state }: { tool: DetectedTool | undefined; state: DetectState }) {
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
  // ── Operator defaults (shared store with the Dispatch tab) ──
  const [data, setData] = useState<OperatorDefaultsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyField, setBusyField] = useState<keyof OperatorDefaults | null>(null);

  const loadDefaults = useCallback(async () => {
    try {
      const response = await fetchOperatorDefaults();
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof payload.error === 'string' ? payload.error : 'Failed to load model settings.');
      }
      setData(payload as OperatorDefaultsResponse);
      setNotice(null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Failed to load model settings.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadDefaults(); }, [loadDefaults]);

  const updateField = useCallback(<K extends keyof OperatorDefaults>(field: K, value: OperatorDefaults[K]) => {
    void (async () => {
      setBusyField(field);
      setNotice(null);
      try {
        const response = await fetchOperatorDefaults({
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
    })();
  }, []);

  // ── Runtime detection ──
  const [detectState, setDetectState] = useState<DetectState>('loading');
  const [tools, setTools] = useState<Record<string, DetectedTool>>({});

  useEffect(() => {
    let alive = true;
    fetch('/api/setup/detect', { cache: 'no-store' })
      .then((r) => r.json())
      .then((payload: { tools?: DetectedTool[] }) => {
        if (!alive) return;
        const map: Record<string, DetectedTool> = {};
        for (const t of payload.tools ?? []) {
          if (t && typeof t.id === 'string') map[t.id] = t;
        }
        setTools(map);
        setDetectState('ready');
      })
      .catch(() => { if (alive) setDetectState('ready'); });
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
    return `${TierLabel(cap.tier)} · ${RUNTIME_BLURB[id] ?? cap.shortLabel}`;
  };

  return (
    <div style={{
      paddingTop: 8,
      paddingLeft: 8,
      paddingRight: 32,
      paddingBottom: 40,
      maxWidth: SETTINGS_CONTENT_MAX_WIDTH,
      fontFamily: APP_FONT_STACK,
    }}>
      <TabHeading
        title="models"
        subtitle="Every model o8 can run — worker runtimes, the orchestrator, your own API keys, and local models. Runtime tuning here writes the same defaults as the Dispatch tab."
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

      <AgentRoleRoutingSection
        routes={data?.roleRoutes ?? []}
        receipts={data?.recentRoleReceipts ?? []}
      />

      {/* ── Runtimes ── */}
      <section style={{ marginTop: 28 }}>
        <SettingsGroup
          header="Runtimes"
          footnote="Detection is live from your machine. Codex and Claude Code take a worker-effort default; Gemini and OpenCode 2 ship wired but hidden until you turn them on. Effort here is the same fallback the Dispatch tab sets."
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
          {/* Gemini — enable toggle (experimentalGemini) */}
          <SettingsRow
            icon={<RuntimeDot color={ORCHESTRATOR_RUNTIMES.gemini.accentColor} />}
            label={ORCHESTRATOR_RUNTIMES.gemini.label}
            subtitle={lockedSub('experimentalGemini', runtimeSubtitle('gemini'))}
            accessory={
              <TrailingCluster>
                <DetectionPill tool={tools.gemini} state={detectState} />
                <SettingsToggleButton
                  checked={values.experimentalGemini}
                  disabled={envLocked('experimentalGemini') || busyField === 'experimentalGemini'}
                  onChange={(next) => {
                    updateField('experimentalGemini', next);
                    if (!next && values.defaultDispatchRuntime === 'gemini') {
                      updateField('defaultDispatchRuntime', 'codex');
                    }
                  }}
                />
              </TrailingCluster>
            }
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
      </section>

      <section style={{ marginTop: 28 }}>
        <ClaudeCodeHarnessSection />
      </section>

      <section style={{ marginTop: 28 }}>
        <SettingsGroup
          header="Engineering Brain"
          footnote={`Your subscription profile decides which signed-in CLI o8 may use. When Codex is selected or Claude is unavailable, Brain answers run on this explicit route instead of silently inheriting a worker or orchestrator model. Current profile: ${values.subscriptionProfile}.`}
        >
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

      {/* ── opencode (model-agnostic) ── */}
      <section style={{ marginTop: 28 }}>
        <SettingsGroup
          header="OpenCode 2 models"
          footnote="OpenCode 2 is not bound to one provider. These lists come from your own install, so they show exactly the models your provider keys can reach. Leave either unset to use OpenCode 2's default. The composer can still override the orchestrator model for a single turn."
        >
          <SettingsRow
            icon={<CpuIcon />}
            label="Orchestrator model"
            subtitle={lockedSub('opencodeOrchestratorModel', values.opencodeOrchestratorModel ?? 'Unset — OpenCode 2 picks')}
            accessory={
              <AcpModelPickerPopover
                label={values.opencodeOrchestratorModel ?? 'Choose'}
                value={values.opencodeOrchestratorModel}
                onSelect={(next) => { updateField('opencodeOrchestratorModel', next); }}
                onClear={() => { updateField('opencodeOrchestratorModel', null); }}
                disabled={envLocked('opencodeOrchestratorModel') || busyField === 'opencodeOrchestratorModel'}
              />
            }
            divider
          />
          <SettingsRow
            icon={<CpuIcon />}
            label="Worker model"
            subtitle={lockedSub('opencodeWorkerModel', values.opencodeWorkerModel ?? 'Unset — the adapter default')}
            accessory={
              <AcpModelPickerPopover
                label={values.opencodeWorkerModel ?? 'Choose'}
                value={values.opencodeWorkerModel}
                onSelect={(next) => { updateField('opencodeWorkerModel', next); }}
                onClear={() => { updateField('opencodeWorkerModel', null); }}
                disabled={envLocked('opencodeWorkerModel') || busyField === 'opencodeWorkerModel'}
              />
            }
          />
        </SettingsGroup>
      </section>

      {/* ── Orchestrator ── */}
      <section style={{ marginTop: 28 }}>
        <SettingsGroup
          header="Orchestrator"
          footnote="The model behind the Orchestrator tab. Backend selection, the reviewer, and supervision live in Dispatch — this is the one model choice that belongs with the rest of your models."
        >
          <SettingsRow
            icon={<CpuIcon />}
            label="Native Claude model"
            subtitle={lockedSub('orchestratorModel', 'Used when the Claude Code harness source is Native account; other sources use the harness model above')}
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
          <SettingsRow
            icon={<CpuIcon />}
            label="Backend & supervision"
            subtitle="Orchestrator backend, reviewer, worker pairing, and heal-bot"
            onPress={onNavigateTab ? () => onNavigateTab('operator-defaults') : undefined}
            value="Dispatch"
            chevron={Boolean(onNavigateTab)}
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

      {/* ── API keys (BYOK — unhidden here, no env flag) ── */}
      <section style={{ marginTop: 28 }}>
        <GroupHeader>API keys</GroupHeader>
        <div style={{
          borderRadius: 14,
          border: '1px solid var(--t-panel-border)',
          background: 'var(--t-bg-card)',
          paddingLeft: 14,
          paddingRight: 14,
          paddingTop: 2,
          paddingBottom: 6,
          maxWidth: 620,
        }}>
          <ApiKeysProviderList />
        </div>
        <div style={{ maxWidth: 620 }}>
          <GroupFootnote>
            Bring your own provider keys. AES-256-GCM encrypted, written to <span style={{ fontFamily: 'var(--font-sans-system)' }}>~/.o8/.env.local</span>, and active immediately — they never leave this machine.
          </GroupFootnote>
        </div>
      </section>

      {/* ── Local models — operator-owned compute is never paywalled ── */}
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

      <div style={{ marginTop: 32, maxWidth: 620 }}>
        <span style={{ fontSize: 11, color: RAMS_INK_QUIET, fontFamily: APP_FONT_STACK, letterSpacing: '-0.005em' }}>
          Runtime effort and toggles also appear in Dispatch — both surfaces write the same operator defaults.
        </span>
      </div>
    </div>
  );
}
