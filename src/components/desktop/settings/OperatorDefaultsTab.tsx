'use client';

/**
 * OperatorDefaultsTab — the Dispatch settings page (epic #1450).
 *
 * Two halves: the regular view (fleet caps, supervision, orchestrator brain,
 * dispatch runtime — what any operator touches in week one) and the Founders
 * section (DispatchFoundersSection — experimental flags, model tiers, Brain
 * routing, local models), rendered only when the entitlement says founder.
 * The gate is VISIBILITY ONLY: every write goes through the same
 * /api/panel/operator-defaults route regardless of what the UI shows.
 * Env-sourced fields stay locked with the reason in the row subtitle.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  APP_FONT_STACK,
  MONO_FONT_STACK,
  RAMS_ACCENT,
  RAMS_INK_QUIET,
  SettingsSegmented,
  TabHeading,
  SETTINGS_CONTENT_MAX_WIDTH,
} from './shared';
import { GroupFootnote, GroupHeader, SettingsGroup, SettingsRow } from './grouped';
import { fetchOperatorDefaults } from './operator-defaults-client';
import { useEntitlement } from '@/lib/entitlement/context';
import { resolveEffectiveDefaultOrchestratorBackend } from '@/lib/operator/dispatch-runtime-default';
import { DispatchFoundersSection } from './DispatchFoundersSection';
import { WorktreeRetentionSection } from './WorktreeRetentionSection';
import {
  PickerMenu,
  SUBSCRIPTION_PROFILE_OPTIONS,
  ORCHESTRATOR_MODEL_OPTIONS,
  DISPATCH_RUNTIME_OPTIONS,
  CODEX_WORKER_EFFORT_OPTIONS,
  CLAUDE_WORKER_EFFORT_OPTIONS,
  ENV_LOCKED_REASON,
  REQUIRE_APPROVAL_OPTIONS,
  resolvePickerGroupOpen,
  type AutoApplyUpdates,
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

const DEFAULT_WORKER_RUNTIME_OPTIONS = DISPATCH_RUNTIME_OPTIONS.filter((opt) =>
  opt.value === 'codex' || opt.value === 'claude-code');

type CliHouseStatus = NonNullable<OperatorDefaultsResponse['cliAuth']>['statuses']['codex'];

function cliStatusLabel(status: CliHouseStatus | undefined) {
  if (!status?.installed) return 'not installed';
  if (!status.authenticated) return 'not signed in';
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
  useEffect(() => {
    let alive = true;
    fetch('/api/setup/orchestrator-backends')
      .then((r) => r.json())
      .then((d) => { if (alive) setHermesAvailable(Boolean(d?.hermes)); })
      .catch(() => { /* picker just omits Hermes */ });
    return () => { alive = false; };
  }, []);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyField, setBusyField] = useState<keyof OperatorDefaults | null>(null);
  const [openDispatchPicker, setOpenDispatchPicker] = useState<string | null>(null);

  const loadDefaults = useCallback(async () => {
    try {
      const response = await fetchOperatorDefaults();
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

  const updateFieldAsync = useCallback(async <K extends keyof OperatorDefaults>(field: K, value: OperatorDefaults[K]) => {
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
  }, []);

  const updateField = useCallback(<K extends keyof OperatorDefaults>(field: K, value: OperatorDefaults[K]) => {
    void updateFieldAsync(field, value);
  }, [updateFieldAsync]);

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
    const backend = resolveEffectiveDefaultOrchestratorBackend({
      orchestratorBackend: values.orchestratorBackend,
      inAppOrchestratorEnabled: values.inAppOrchestratorEnabled,
    });
    const backendLabel = backend === 'claude' ? 'Claude' : backend === 'codex' ? 'Codex' : backend;
    return `Paired opposite your orchestrator (${backendLabel}) — pick one to override`;
  })();
  const profileHint = cliAuth?.suggestedSubscriptionProfile.profile
    && cliAuth.suggestedSubscriptionProfile.profile !== activeProfile
    ? cliAuth.suggestedSubscriptionProfile
    : null;

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
        title="dispatch & supervision"
        subtitle="How the fleet runs: how many agents at once, what happens when work overlaps, and who the orchestrator brain is."
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
          footnote="Advisory dispatches everything and resolves conflicts at rebase time; Strict holds overlapping packets until the active one merges — safer, slower."
        >
          <SettingsRow
            icon={<LanesIcon />}
            label="Agents in flight"
            subtitle={lockedSub('parallelCap', `Up to ${values.parallelCap} dispatched packets run at once`)}
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
            subtitle={lockedSub('overlapGate', 'When two packets predict changes to the same files')}
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
          />
        </SettingsGroup>
      </section>

      <section style={{ marginTop: 28 }}>
        <SettingsGroup
          header="Supervision"
          footnote="When a packet fails verification, heal-bot tries a scoped fix before asking you. Auto-apply installs a downloaded update only after all lanes are idle and you've been inactive for five minutes."
        >
          <SettingsRow
            icon={<WrenchIcon />}
            label="Heal-bot"
            subtitle={lockedSub('healBotEnabled', 'Attempt an automatic fix before asking a human')}
            checked={values.healBotEnabled}
            disabled={envLocked('healBotEnabled') || busyField === 'healBotEnabled'}
            onToggle={(next) => { updateField('healBotEnabled', next); }}
            divider
          />
          <SettingsRow
            icon={<InboxIcon />}
            label="Auto-escalate to chat"
            subtitle={lockedSub('supervisorAutoEscalate', 'Surface supervisor failures in the orchestrator chat')}
            checked={values.supervisorAutoEscalate}
            disabled={envLocked('supervisorAutoEscalate') || busyField === 'supervisorAutoEscalate'}
            onToggle={(next) => { updateField('supervisorAutoEscalate', next); }}
            divider
          />
          <SettingsRow
            icon={<InboxIcon />}
            label="Review continuation"
            subtitle={lockedSub('reviewContinuation', 'When a mission lane reaches review, queue one orchestrator turn to review + merge it')}
            checked={values.reviewContinuation}
            disabled={envLocked('reviewContinuation') || busyField === 'reviewContinuation'}
            onToggle={(next) => { updateField('reviewContinuation', next); }}
            divider
          />
          <SettingsRow
            icon={<MergeIcon />}
            label="Merge approval"
            subtitle={lockedSub('requireApproval', 'Surface routes review-worthy work back to its dispatcher; easy reviewed packets keep moving')}
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
            label="Auto-apply updates"
            subtitle={lockedSub('autoApplyUpdates', 'Install downloaded updates when everything is idle')}
            accessory={
              <SettingsSegmented
                value={values.autoApplyUpdates}
                onChange={(next) => { updateField('autoApplyUpdates', next as AutoApplyUpdates); }}
                options={[
                  { value: 'off', label: 'Off' },
                  { value: 'when-idle', label: 'When idle' },
                ]}
              />
            }
            disabled={envLocked('autoApplyUpdates') || busyField === 'autoApplyUpdates'}
          />
        </SettingsGroup>
      </section>

      <section style={{ marginTop: 28 }}>
        <SettingsGroup
          header="Orchestrator"
          footnote="Auto follows the classic toggle (Claude when on, Codex when off). Collide runs Claude + Codex as independent proposers with one synthesizer — the upgraded Claude, at roughly twice the Claude draw."
        >
          <SettingsRow
            icon={<CpuIcon />}
            label="Backend"
            subtitle={profileOverrideReason ?? lockedSub('orchestratorBackend', 'The brain that drives chat and background turns')}
            accessory={
              <SettingsSegmented
                value={values.orchestratorBackend}
                onChange={(next) => { updateField('orchestratorBackend', next as OrchestratorBackendSetting); }}
                options={[
                  { value: 'auto', label: 'Auto' },
                  { value: 'codex', label: 'Codex' },
                  { value: 'claude', label: 'Claude' },
                  // OpenClaw hidden from the picker (Q ruling 2026-07-16, not
                  // one-click yet); shown only if it's already the selection so
                  // an existing choice stays visible + escapable.
                  ...(values.orchestratorBackend === 'openclaw' ? [{ value: 'openclaw', label: 'OpenClaw' }] : []),
                  ...(hermesAvailable || values.orchestratorBackend === 'hermes' ? [{ value: 'hermes', label: 'Hermes' }] : []),
                  { value: 'collide', label: 'Collide' },
                ]}
              />
            }
            disabled={Boolean(profileOverrideReason) || envLocked('orchestratorBackend') || busyField === 'orchestratorBackend'}
            divider
          />
          <SettingsRow
            icon={<CpuIcon />}
            label="Reviewer"
            subtitle={profileOverrideReason ?? lockedSub('reviewerBackend', 'Who reviews finished lanes before merge — Follow rides the Backend above')}
            accessory={
              <SettingsSegmented
                value={values.reviewerBackend}
                onChange={(next) => { updateField('reviewerBackend', next as ReviewerBackendSetting); }}
                options={[
                  { value: 'follow', label: 'Follow' },
                  { value: 'claude', label: 'Claude' },
                  { value: 'codex', label: 'Codex' },
                ]}
              />
            }
            disabled={Boolean(profileOverrideReason) || envLocked('reviewerBackend') || busyField === 'reviewerBackend'}
            divider
          />
          <SettingsRow
            icon={<InboxIcon />}
            label="Packet explainer"
            subtitle={lockedSub('packetExplainerEnabled', 'Generate an HTML explainer + quiz for each reviewed packet (non-blocking)')}
            checked={values.packetExplainerEnabled}
            disabled={envLocked('packetExplainerEnabled') || busyField === 'packetExplainerEnabled'}
            onToggle={(next) => { updateField('packetExplainerEnabled', next); }}
            divider
          />
          <SettingsRow
            icon={<MergeIcon />}
            label="Quiz-gated merge"
            subtitle={lockedSub('quizGateEnabled', 'Block the human Merge button on large packets until the explainer quiz is passed')}
            checked={values.quizGateEnabled}
            disabled={envLocked('quizGateEnabled') || busyField === 'quizGateEnabled'}
            onToggle={(next) => { updateField('quizGateEnabled', next); }}
            divider
          />
          <SettingsRow
            icon={<BuyinDocIcon />}
            label="Buy-in doc on merge"
            subtitle={lockedSub('buyinDocEnabled', 'Generate a shareable HTML buy-in doc (demo-first, plain-language) after a merge (non-blocking)')}
            checked={values.buyinDocEnabled}
            disabled={envLocked('buyinDocEnabled') || busyField === 'buyinDocEnabled'}
            onToggle={(next) => { updateField('buyinDocEnabled', next); }}
            divider
          />
          <SettingsRow
            icon={<CpuIcon />}
            label="Claude model"
            subtitle={lockedSub('orchestratorModel', 'Powers the Orchestrator tab — applies to new turns')}
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

      {foundersMode ? (
        <>
          <div style={{
            marginTop: 40,
            marginBottom: 12,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}>
            <span style={{
              fontFamily: APP_FONT_STACK,
              fontSize: 10,
              fontWeight: 400,
              letterSpacing: '0.2em',
              textTransform: 'uppercase',
              color: RAMS_ACCENT,
            }}>
              Founders
            </span>
            <div style={{ flex: 1, height: 1, background: 'var(--t-divider, rgba(17,17,17,0.06))' }} />
            <span style={{
              fontFamily: APP_FONT_STACK,
              fontSize: 10,
              fontWeight: 400,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: RAMS_INK_QUIET,
            }}>
              Advanced tuning
            </span>
          </div>
          <GroupFootnote>
            The extras. Environment variables always win over anything set here — a row showing{' '}
            <span style={{ fontFamily: MONO_FONT_STACK, fontSize: 11 }}>locked</span> means an env var owns it.
          </GroupFootnote>
          <div style={{ height: 8 }} />
          <DispatchFoundersSection
            values={values}
            sources={sources}
            busyField={busyField}
            updateField={updateField}
          />
        </>
      ) : (
        <div style={{ marginTop: 36 }}>
          <GroupHeader>Founders</GroupHeader>
          <GroupFootnote>
            Advanced tuning — experimental runtimes, model tiers, Brain routing, and local models — unlocks with a founding license.
          </GroupFootnote>
        </div>
      )}
    </div>
  );
}
