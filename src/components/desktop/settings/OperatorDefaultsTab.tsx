'use client';

/**
 * OperatorDefaultsTab — the Dispatch settings page (epic #1450).
 *
 * The common path holds fleet, supervision, orchestration, and worker routing.
 * Advanced operator-owned model, Brain, and local-inference controls remain
 * available to every installation; founder mode only reveals experimental
 * preview flags. Env-sourced fields stay locked with the reason in the row.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  APP_FONT_STACK,
  MONO_FONT_STACK,
  SettingsSegmented,
  TabHeading,
  SETTINGS_CONTENT_MAX_WIDTH,
} from './shared';
import { GroupFootnote, GroupHeader, SettingsGroup, SettingsRow } from './grouped';
import { fetchOperatorDefaults } from './operator-defaults-client';
import { ApfsDependencyImagesRow } from './ApfsDependencyImagesRow';
import { DEFAULT_QUIZ_FILE_THRESHOLD } from '@/lib/orchestrator/quiz-gate';
import { JudgmentProviderRow } from './JudgmentProviderRow';
import { useEntitlement } from '@/lib/entitlement/context';
import { DispatchFoundersSection } from './DispatchFoundersSection';
import { WorktreeRetentionSection } from './WorktreeRetentionSection';
import { SettingsTomlEditor } from './SettingsTomlEditor';
import {
  PickerMenu,
  SUBSCRIPTION_PROFILE_OPTIONS,
  ORCHESTRATOR_MODEL_OPTIONS,
  DISPATCH_RUNTIME_OPTIONS,
  CODEX_WORKER_EFFORT_OPTIONS,
  CLAUDE_WORKER_EFFORT_OPTIONS,
  ENV_LOCKED_REASON,
  REQUIRE_APPROVAL_OPTIONS,
  MERGE_APPROVAL_DESCRIPTIONS,
  resolvePickerGroupOpen,
  type UpdateAutoApply,
  type DispatchRuntime,
  type OperatorDefaults,
  type OperatorDefaultsResponse,
  type OrchestratorBackendSetting,
  type ReviewerBackendSetting,
  type RequireApproval,
  type OverlapGateMode,
  type SubscriptionProfile,
} from './dispatch-shared';

const PARALLEL_CAP_PRESETS: Array<{ key: string; label: string; value: number }> = [
  { key: 'conservative', label: '2', value: 2 },
  { key: 'balanced', label: '5', value: 5 },
  { key: 'power-user', label: '8', value: 8 },
];

const DEFAULT_WORKER_RUNTIME_OPTIONS = DISPATCH_RUNTIME_OPTIONS;
type ExecutionCarrierSelection = 'direct' | 'ori';
const EXECUTION_CARRIER_OPTIONS: Array<{ value: ExecutionCarrierSelection; label: string; detail: string }> = [
  { value: 'direct', label: 'Direct', detail: 'Launch the selected runtime CLI directly.' },
  { value: 'ori', label: 'Ori', detail: 'Use Ori credentials and routing while Codex keeps session ownership.' },
];

type CliHouseStatus = NonNullable<OperatorDefaultsResponse['cliAuth']>['statuses']['codex'];

function cliStatusLabel(status: CliHouseStatus | undefined) {
  if (!status?.installed) return 'not installed';
  // Only a definite refusal reads as "not signed in". A house that is usable without
  // native credential evidence — inconclusive probe, or a non-native Claude carrier —
  // is reported as usable rather than accused of being signed out.
  if (!status.ready) return 'not signed in';
  if (!status.authenticated) return 'installed + usable';
  return 'installed + signed in';
}

// ── Minimal raw-SVG glyphs for row icon tiles ──

function LanesIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ display: 'block', flexShrink: 0 }}>
      <line x1="4" y1="4" x2="4" y2="20" />
      <line x1="12" y1="4" x2="12" y2="20" />
      <line x1="20" y1="4" x2="20" y2="20" />
    </svg>
  );
}

function MergeIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M6 21V9a9 9 0 0 0 9 9" />
    </svg>
  );
}

function WrenchIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  );
}

function InboxIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
      <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </svg>
  );
}

function BuyinDocIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M3 11l18-5v12L3 14v-3z" />
      <path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" />
    </svg>
  );
}

function UpdateIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M21 12a9 9 0 1 1-9-9" />
      <polyline points="21 3 21 9 15 9" />
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

function RocketIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
      <path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
      <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
      <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
    </svg>
  );
}

export function OperatorDefaultsTab() {
  const [data, setData] = useState<OperatorDefaultsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const { founder, plan } = useEntitlement();
  const foundersMode = founder !== null || plan === 'founder';
  // Hermes (ACP backend) only appears in the backend picker when its binary is present.
  const [hermesAvailable, setHermesAvailable] = useState(false);
  const [opencodeAvailable, setOpencodeAvailable] = useState(false);
  useEffect(() => {
    let alive = true;
    fetch('/api/setup/orchestrator-backends')
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        setHermesAvailable(Boolean(d?.hermes));
        setOpencodeAvailable(Boolean(d?.opencode));
      })
      .catch(() => { /* picker just omits Hermes */ });
    return () => { alive = false; };
  }, []);
  const [notice, setNotice] = useState<string | null>(null);
  const [editingToml, setEditingToml] = useState(false);
  const [busyField, setBusyField] = useState<keyof OperatorDefaults | null>(null);
  const [openDispatchPicker, setOpenDispatchPicker] = useState<string | null>(null);
  const loadSequenceRef = useRef(0);
  const mutationSequenceRef = useRef(0);

  const loadDefaults = useCallback(async () => {
    const sequence = loadSequenceRef.current + 1;
    loadSequenceRef.current = sequence;
    try {
      const response = await fetchOperatorDefaults({}, { fresh: true });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof payload.error === 'string' ? payload.error : 'Failed to load operator defaults.');
      }
      if (loadSequenceRef.current !== sequence) return;
      const next = payload as OperatorDefaultsResponse;
      setData(next);
      setNotice(next.settingsToml?.error ?? null);
    } catch (error) {
      if (loadSequenceRef.current !== sequence) return;
      setNotice(error instanceof Error ? error.message : 'Failed to load operator defaults.');
    } finally {
      if (loadSequenceRef.current === sequence) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDefaults();
  }, [loadDefaults]);

  useEffect(() => {
    if (editingToml) return;
    const refreshOnFocus = () => { void loadDefaults(); };
    window.addEventListener('focus', refreshOnFocus);
    return () => window.removeEventListener('focus', refreshOnFocus);
  }, [editingToml, loadDefaults]);

  const updateFieldAsync = useCallback(async <K extends keyof OperatorDefaults>(field: K, value: OperatorDefaults[K]) => {
    const sequence = mutationSequenceRef.current + 1;
    mutationSequenceRef.current = sequence;
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
      if (mutationSequenceRef.current === sequence) setData(payload as OperatorDefaultsResponse);
    } catch (error) {
      if (mutationSequenceRef.current === sequence) {
        setNotice(error instanceof Error ? error.message : 'Failed to update setting.');
      }
    } finally {
      if (mutationSequenceRef.current === sequence) setBusyField(null);
    }
  }, []);

  const updateField = useCallback(<K extends keyof OperatorDefaults>(field: K, value: OperatorDefaults[K]) => {
    void updateFieldAsync(field, value);
  }, [updateFieldAsync]);

  const handleTomlSaved = useCallback((payload: OperatorDefaultsResponse) => {
    setData(payload);
    setNotice(payload.settingsToml?.error ?? null);
    setEditingToml(false);
  }, []);

  const openTomlEditor = useCallback(async () => {
    await loadDefaults();
    setEditingToml(true);
  }, [loadDefaults]);

  const values = data?.values;
  const sources = data?.sources;
  const cliAuth = data?.cliAuth;

  const activePresetKey = useMemo(() => {
    if (!values) return '';
    const match = PARALLEL_CAP_PRESETS.find((preset) => preset.value === values.parallelCap);
    return match?.key ?? '';
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
        color: 'var(--t-brand-red, #b91c1c)',
        fontSize: 13,
        fontFamily: APP_FONT_STACK,
      }}>
        {notice ?? 'Unable to load operator defaults.'}
      </div>
    );
  }

  if (editingToml && data.settingsToml) {
    return (
      <SettingsTomlEditor
        initialText={data.settingsToml.text}
        initialRevision={data.settingsToml.revision}
        filePath={data.settingsToml.path}
        initialError={data.settingsToml.error}
        onCancel={() => setEditingToml(false)}
        onReload={loadDefaults}
        onSaved={handleTomlSaved}
      />
    );
  }

  const envLocked = (field: keyof OperatorDefaults) => sources[field] === 'env';
  const lockedSub = (field: keyof OperatorDefaults, normal: string) =>
    envLocked(field) ? ENV_LOCKED_REASON : normal;
  const activeProfile = values.subscriptionProfile;
  const profileOverrideReason = activeProfile === 'claude-only'
    ? 'Subscription profile is Claude only — this is pinned to Claude.'
    : activeProfile === 'codex-only'
      ? 'Subscription profile is Codex / OpenAI only — this is pinned to Codex.'
      : null;
  const dispatchDefaultSubtitle = (() => {
    if (profileOverrideReason) return profileOverrideReason;
    if (envLocked('defaultDispatchRuntime')) return ENV_LOCKED_REASON;
    if (sources.defaultDispatchRuntime !== 'default') {
      return 'Used when you say "dispatch" without naming a runtime';
    }
    return 'Codex is the default worker — pick any available runtime to override';
  })();
  const carrierCompatibilityReason = values.defaultDispatchRuntime === 'codex'
    ? null
    : 'Ori is available when the effective default worker is Codex.';
  const profileHint = cliAuth?.suggestedSubscriptionProfile.profile
    && cliAuth.suggestedSubscriptionProfile.profile !== activeProfile
    ? cliAuth.suggestedSubscriptionProfile
    : null;

  return (
    <div style={{
      paddingTop: 8,
      paddingLeft: 8,
      paddingRight: 8,
      paddingBottom: 40,
      maxWidth: SETTINGS_CONTENT_MAX_WIDTH,
      fontFamily: APP_FONT_STACK,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 20 }}>
        <TabHeading
          title="dispatch & supervision"
          subtitle="How the fleet runs: how many agents at once, what happens when work overlaps, and who the orchestrator brain is."
        />
        <button
          type="button"
          onClick={() => { void openTomlEditor(); }}
          style={{
            flexShrink: 0,
            height: 32,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxSizing: 'border-box',
            lineHeight: 1,
            paddingTop: 0,
            paddingBottom: 0,
            marginTop: 2,
            paddingLeft: 13,
            paddingRight: 13,
            border: '1px solid var(--t-panel-border)',
            borderRadius: 7,
            background: 'var(--t-input-bg)',
            color: 'var(--t-text-muted)',
            fontFamily: APP_FONT_STACK,
            fontSize: 11,
            fontWeight: 300,
            letterSpacing: '-0.1px',
            cursor: 'pointer',
          }}
        >
          Edit in settings.toml
        </button>
      </div>

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

      <section>
        <SettingsGroup
          header="Fleet"
          footnote="Strict waits while another active task may edit the same files. Advisory allows both tasks to run and resolves conflicts later. New setups use 5 agents and Strict; saved choices are kept."
        >
          <SettingsRow
            icon={<LanesIcon />}
            label="Concurrent agents"
            subtitle={lockedSub('parallelCap', `Up to ${values.parallelCap} agent tasks run at once`)}
            accessory={
              <SettingsSegmented
                value={activePresetKey}
                onChange={(key) => {
                  const preset = PARALLEL_CAP_PRESETS.find((p) => p.key === key);
                  if (preset) updateField('parallelCap', preset.value);
                }}
                options={PARALLEL_CAP_PRESETS.map((p) => ({ value: p.key, label: p.label }))}
              />
            }
            disabled={envLocked('parallelCap') || busyField === 'parallelCap'}
            divider
          />
          <SettingsRow
            icon={<MergeIcon />}
            label="Overlapping work"
            subtitle={lockedSub('overlapGate', 'Choose whether tasks that may edit the same files can run together')}
            accessory={
              <SettingsSegmented
                value={values.overlapGate}
                onChange={(next) => { updateField('overlapGate', next as OverlapGateMode); }}
                options={[
                  { value: 'advisory', label: 'Advisory' },
                  { value: 'strict', label: 'Strict' },
                ]}
              />
            }
            disabled={envLocked('overlapGate') || busyField === 'overlapGate'}
            divider
          />
          <ApfsDependencyImagesRow
            icon={<WrenchIcon />}
            persistedValue={values.apfsDependencyImages}
            effectiveOverride={data.effectiveOverride.apfsDependencyImages}
            busy={busyField === 'apfsDependencyImages'}
            onToggle={(next) => { updateField('apfsDependencyImages', next); }}
          />
        </SettingsGroup>
      </section>

      <section style={{ marginTop: 28 }}>
        <SettingsGroup
          header="Supervision"
          footnote="Automatic fixes, chat investigations, and reviews use your connected AI runtime and may use its allowance. Merge approval controls when to ask before merging; required checks still apply."
        >
          <SettingsRow
            icon={<WrenchIcon />}
            label="Automatically fix failed checks"
            subtitle={lockedSub('healBotEnabled', 'Try one focused AI repair, limited to five minutes, before asking for help. Changes take effect after restarting o8.')}
            checked={values.healBotEnabled}
            disabled={envLocked('healBotEnabled') || busyField === 'healBotEnabled'}
            onToggle={(next) => { updateField('healBotEnabled', next); }}
            divider
          />
          <SettingsRow
            icon={<InboxIcon />}
            label="Investigate failures in chat"
            subtitle={lockedSub('supervisorAutoEscalate', 'Start an AI investigation in chat when a task needs help. When off, failures remain visible in task status and activity.')}
            checked={values.supervisorAutoEscalate}
            disabled={envLocked('supervisorAutoEscalate') || busyField === 'supervisorAutoEscalate'}
            onToggle={(next) => { updateField('supervisorAutoEscalate', next); }}
            divider
          />
          <SettingsRow
            icon={<InboxIcon />}
            label="Automatically review completed work"
            subtitle={lockedSub('reviewContinuation', 'Start an AI review when an assigned task is ready. It can request fixes or merge approved changes, subject to Merge approval below.')}
            checked={values.reviewContinuation}
            disabled={envLocked('reviewContinuation') || busyField === 'reviewContinuation'}
            onToggle={(next) => { updateField('reviewContinuation', next); }}
            divider
          />
          <SettingsRow
            icon={<MergeIcon />}
            label="Merge approval"
            subtitle={lockedSub('requireApproval', MERGE_APPROVAL_DESCRIPTIONS[values.requireApproval])}
            accessory={
              <SettingsSegmented
                value={values.requireApproval}
                onChange={(next) => { updateField('requireApproval', next as RequireApproval); }}
                options={REQUIRE_APPROVAL_OPTIONS}
              />
            }
            disabled={envLocked('requireApproval') || busyField === 'requireApproval'}
            divider
          />
          <SettingsRow
            icon={<UpdateIcon />}
            label="Install app updates automatically"
            subtitle={lockedSub('updateAutoApply', 'Install an available update and restart o8 when no agents, terminal sessions, or background jobs are active.')}
            accessory={
              <SettingsSegmented
                value={values.updateAutoApply}
                onChange={(next) => { updateField('updateAutoApply', next as UpdateAutoApply); }}
                options={[
                  { value: 'off', label: 'Off' },
                  { value: 'idle', label: 'When idle' },
                ]}
              />
            }
            disabled={envLocked('updateAutoApply') || busyField === 'updateAutoApply'}
          />
        </SettingsGroup>
      </section>

      <section style={{ marginTop: 28 }}>
        <SettingsGroup
          header="Orchestrator"
          footnote="The orchestrator leads chat and coordinates agent tasks. Claude + Codex compares independent responses and combines them; it uses both AI runtimes."
        >
          <SettingsRow
            icon={<CpuIcon />}
            label="Chat provider"
            subtitle={profileOverrideReason ?? lockedSub('orchestratorBackend', `Choose the AI that leads chat and coordinates tasks. Automatic currently uses ${values.inAppOrchestratorEnabled ? 'Claude' : 'Codex'}.`)}
            accessory={
              <PickerMenu<string>
                value={values.orchestratorBackend}
                disabled={Boolean(profileOverrideReason) || envLocked('orchestratorBackend') || busyField === 'orchestratorBackend'}
                minWidth={170}
                onChange={(next) => { updateField('orchestratorBackend', next as OrchestratorBackendSetting); }}
                options={[
                  { value: 'auto', label: 'Automatic' },
                  { value: 'codex', label: 'Codex' },
                  { value: 'claude', label: 'Claude' },
                  // OpenClaw hidden from the picker (Q ruling 2026-07-16, not
                  // one-click yet); shown only if it's already the selection so
                  // an existing choice stays visible + escapable.
                  ...(values.orchestratorBackend === 'openclaw' ? [{ value: 'openclaw', label: 'OpenClaw' }] : []),
                  ...(hermesAvailable || values.orchestratorBackend === 'hermes' ? [{ value: 'hermes', label: 'Hermes' }] : []),
                  // Shown when the binary is present, mirroring Hermes. Without
                  // this the composer could select opencode while Settings
                  // rendered no selected segment at all.
                  ...(opencodeAvailable || values.orchestratorBackend === 'opencode' ? [{ value: 'opencode', label: 'OpenCode 2' }] : []),
                  { value: 'collide', label: 'Claude + Codex' },
                ]}
              />
            }
            disabled={Boolean(profileOverrideReason) || envLocked('orchestratorBackend') || busyField === 'orchestratorBackend'}
            divider
          />
          <SettingsRow
            icon={<CpuIcon />}
            label="Code review provider"
            subtitle={profileOverrideReason ?? lockedSub('reviewerBackend', 'Choose the AI that reviews completed changes. Same as chat uses the provider selected above.')}
            accessory={
              <SettingsSegmented
                value={values.reviewerBackend}
                onChange={(next) => { updateField('reviewerBackend', next as ReviewerBackendSetting); }}
                options={[
                  { value: 'follow', label: 'Same as chat' },
                  { value: 'claude', label: 'Claude' },
                  { value: 'codex', label: 'Codex' },
                ]}
              />
            }
            disabled={Boolean(profileOverrideReason) || envLocked('reviewerBackend') || busyField === 'reviewerBackend'}
            divider
          />
          <SettingsRow
            icon={<CpuIcon />}
            label="Claude account model"
            subtitle={lockedSub('orchestratorModel', 'Applies when Claude Code uses Native account in Models settings. Other connections use their own model settings.')}
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
            icon={<InboxIcon />}
            label="Explain completed changes"
            subtitle={lockedSub('packetExplainerEnabled', 'Create a readable report and short quiz when a task is ready for review. Report generation does not block review.')}
            checked={values.packetExplainerEnabled}
            disabled={envLocked('packetExplainerEnabled') || busyField === 'packetExplainerEnabled'}
            onToggle={(next) => { updateField('packetExplainerEnabled', next); }}
            divider
          />
          <SettingsRow
            icon={<MergeIcon />}
            label="Require a quiz before manual merge"
            subtitle={lockedSub('quizGateEnabled', `For changes to more than ${DEFAULT_QUIZ_FILE_THRESHOLD} files with a generated quiz, require correct answers before you click Merge. Automated merges are unaffected.`)}
            checked={values.quizGateEnabled}
            disabled={envLocked('quizGateEnabled') || busyField === 'quizGateEnabled'}
            onToggle={(next) => { updateField('quizGateEnabled', next); }}
            divider
          />
          <SettingsRow
            icon={<BuyinDocIcon />}
            label="Create a summary after merge"
            subtitle={lockedSub('buyinDocEnabled', 'Create a shareable report of what changed, why, and how it was checked. Includes available demos; does not delay the merge.')}
            checked={values.buyinDocEnabled}
            disabled={envLocked('buyinDocEnabled') || busyField === 'buyinDocEnabled'}
            onToggle={(next) => { updateField('buyinDocEnabled', next); }}
            divider
          />
          <JudgmentProviderRow
            icon={<MergeIcon />}
            value={values.judgmentProvider}
            path={data?.judgmentPath}
            managedVisible={values.judgmentManagedOptionVisible}
            busy={busyField === 'judgmentProvider'}
            onChange={(next) => { updateField('judgmentProvider', next); }}
          />
        </SettingsGroup>
      </section>

      <section style={{ marginTop: 28 }}>
        <SettingsGroup
          header="Dispatch runtime"
          footnote={<>Pick a CLI you actually have a subscription or API key for — otherwise dispatches die on the CLI boundary. Workers run with full access inside isolated worktrees; the orchestrator gates every packet, so review the diff before merging.</>}
        >
          <SettingsRow
            icon={<RocketIcon />}
            label="Subscription profile"
            subtitle={lockedSub('subscriptionProfile', [
              SUBSCRIPTION_PROFILE_OPTIONS.find((opt) => opt.value === activeProfile)?.detail ?? 'Use both houses by default',
              `Codex: ${cliStatusLabel(cliAuth?.statuses.codex)} · Claude: ${cliStatusLabel(cliAuth?.statuses.claude)}`,
              profileHint?.detail ? `${profileHint.detail} Consider ${SUBSCRIPTION_PROFILE_OPTIONS.find((opt) => opt.value === profileHint.profile)?.label}.` : '',
            ].filter(Boolean).join(' '))}
            accessory={
              <PickerMenu<SubscriptionProfile>
                value={activeProfile}
                options={SUBSCRIPTION_PROFILE_OPTIONS}
                onChange={(next) => { updateField('subscriptionProfile', next); }}
                disabled={envLocked('subscriptionProfile') || busyField === 'subscriptionProfile'}
                minWidth={190}
                open={openDispatchPicker === 'subscription-profile'}
                onOpenChange={(open) => setOpenDispatchPicker((current) => resolvePickerGroupOpen(current, 'subscription-profile', open))}
              />
            }
            disabled={envLocked('subscriptionProfile') || busyField === 'subscriptionProfile'}
            divider
          />
          <SettingsRow
            icon={<RocketIcon />}
            label="Default worker"
            subtitle={dispatchDefaultSubtitle}
            accessory={
              <PickerMenu<DispatchRuntime>
                value={values.defaultDispatchRuntime}
                options={DEFAULT_WORKER_RUNTIME_OPTIONS}
                onChange={(next) => { updateField('defaultDispatchRuntime', next); }}
                disabled={Boolean(profileOverrideReason) || envLocked('defaultDispatchRuntime') || busyField === 'defaultDispatchRuntime'}
                minWidth={150}
                open={openDispatchPicker === 'default-worker'}
                onOpenChange={(open) => setOpenDispatchPicker((current) => resolvePickerGroupOpen(current, 'default-worker', open))}
              />
            }
            disabled={Boolean(profileOverrideReason) || envLocked('defaultDispatchRuntime') || busyField === 'defaultDispatchRuntime'}
            divider
          />
          <SettingsRow
            icon={<RocketIcon />}
            label="Execution carrier"
            subtitle={carrierCompatibilityReason ?? 'Optional typed argv and credential wrapper. The runtime still owns sessions, transcripts, costs, and review.'}
            accessory={
              <PickerMenu<ExecutionCarrierSelection>
                value={values.workerExecutionCarrier ?? 'direct'}
                options={carrierCompatibilityReason ? EXECUTION_CARRIER_OPTIONS.slice(0, 1) : EXECUTION_CARRIER_OPTIONS}
                onChange={(next) => { updateField('workerExecutionCarrier', next === 'direct' ? null : next); }}
                disabled={busyField === 'workerExecutionCarrier'}
                minWidth={150}
                open={openDispatchPicker === 'execution-carrier'}
                onOpenChange={(open) => setOpenDispatchPicker((current) => resolvePickerGroupOpen(current, 'execution-carrier', open))}
              />
            }
            disabled={busyField === 'workerExecutionCarrier'}
            divider
          />
          <SettingsRow
            icon={<CpuIcon />}
            label="Codex worker effort"
            subtitle={lockedSub('codexWorkerEffort', 'Fallback effort for spawned Codex workers')}
            accessory={
              <PickerMenu
                value={values.codexWorkerEffort}
                options={CODEX_WORKER_EFFORT_OPTIONS}
                onChange={(next) => { updateField('codexWorkerEffort', next); }}
                disabled={envLocked('codexWorkerEffort') || busyField === 'codexWorkerEffort'}
                minWidth={150}
                open={openDispatchPicker === 'codex-effort'}
                onOpenChange={(open) => setOpenDispatchPicker((current) => resolvePickerGroupOpen(current, 'codex-effort', open))}
              />
            }
            disabled={envLocked('codexWorkerEffort') || busyField === 'codexWorkerEffort'}
            divider
          />
          <SettingsRow
            icon={<CpuIcon />}
            label="Claude worker effort"
            subtitle={lockedSub('claudeWorkerEffort', 'Fallback effort for spawned Claude Code workers')}
            accessory={
              <PickerMenu
                value={values.claudeWorkerEffort}
                options={CLAUDE_WORKER_EFFORT_OPTIONS}
                onChange={(next) => { updateField('claudeWorkerEffort', next); }}
                disabled={envLocked('claudeWorkerEffort') || busyField === 'claudeWorkerEffort'}
                minWidth={150}
                open={openDispatchPicker === 'claude-effort'}
                onOpenChange={(open) => setOpenDispatchPicker((current) => resolvePickerGroupOpen(current, 'claude-effort', open))}
              />
            }
            disabled={envLocked('claudeWorkerEffort') || busyField === 'claudeWorkerEffort'}
          />
        </SettingsGroup>
      </section>

      <section style={{ marginTop: 28 }}>
        <WorktreeRetentionSection />
      </section>

      <div style={{ marginTop: 40 }}>
        <GroupHeader>Advanced routing</GroupHeader>
        <GroupFootnote>
          Model tiers, Brain routing, and local inference stay under your control. Environment variables always win — a row showing{' '}
          <span style={{ fontFamily: MONO_FONT_STACK, fontSize: 11 }}>locked</span> means the environment owns it.
        </GroupFootnote>
        <div style={{ height: 8 }} />
        <DispatchFoundersSection
          values={values}
          sources={sources}
          busyField={busyField}
          updateField={updateField}
          showExperimental={foundersMode}
        />
      </div>
    </div>
  );
}
